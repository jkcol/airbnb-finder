"""Optional FastAPI backend for Airbnb Finder.

The live site runs search in the browser; this server offers the same search
over HTTP. It loads the index built by scripts/build-data.mjs (listing metadata
plus precomputed passage embeddings) and only embeds the query at request time,
either with a local `transformers` model or the Hugging Face Inference API.
Filtering and ranking mirror frontend/src/search.js.
"""
import json
import math
import os
from contextlib import asynccontextmanager
from typing import List, Optional

import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Load env vars from .env if present
load_dotenv()

USE_HF_API = os.getenv("USE_HF_API", "0").lower() in {"1", "true", "yes"}
HF_TOKEN = os.getenv("HUGGINGFACE_API_TOKEN", "").strip()
# Same weights as the ONNX model (Xenova/e5-small-v2) used to embed the listings
MODEL_NAME = os.getenv("MODEL_NAME", "intfloat/e5-small-v2")
TOP_K_DEFAULT = int(os.getenv("TOP_K_DEFAULT", "24"))
# The legacy api-inference.huggingface.co host has been retired in favor of the router.
HF_API_URL = os.getenv(
    "HF_API_URL",
    "https://router.huggingface.co/hf-inference/models/{model}/pipeline/feature-extraction",
)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")]

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

# Keep in sync with QUALITY_WEIGHT in frontend/src/search.js
QUALITY_WEIGHT = 0.02
GENERIC_QUERY = "a comfortable, clean, well-located place to stay"

# ----------------------------
# Embedding backends
# ----------------------------

class Embedder:
    def embed(self, texts: List[str]) -> np.ndarray:
        raise NotImplementedError


class HFInferenceAPIEmbedder(Embedder):
    def __init__(self, model_name: str, token: str):
        if not token:
            raise ValueError("HUGGINGFACE_API_TOKEN is required for Inference API mode")
        self.endpoint = HF_API_URL.format(model=model_name)
        self.headers = {"Authorization": f"Bearer {token}"}

    def embed(self, texts: List[str]) -> np.ndarray:
        resp = requests.post(self.endpoint, headers=self.headers, json={"inputs": texts}, timeout=60)
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"HF Inference API error: {resp.status_code} {resp.text}")
        arr = np.array(resp.json(), dtype=np.float32)
        # Some models may return a list of token embeddings; if so, mean-pool
        if arr.ndim == 3:
            arr = arr.mean(axis=1)
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-12
        return arr / norms


class HFLocalEmbedder(Embedder):
    def __init__(self, model_name: str):
        # Imported lazily so Inference API mode works without torch/transformers installed
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).eval().to(self.device)

    def embed(self, texts: List[str]) -> np.ndarray:
        with self.torch.no_grad():
            encoded = self.tokenizer(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
            encoded = {k: v.to(self.device) for k, v in encoded.items()}
            last_hidden = self.model(**encoded).last_hidden_state  # [B, T, H]
            # Mean pooling with attention mask
            mask = encoded["attention_mask"].unsqueeze(-1)  # [B, T, 1]
            sent = (last_hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
            sent = sent / (sent.norm(dim=1, keepdim=True) + 1e-12)
            return sent.cpu().numpy()

# ----------------------------
# Index
# ----------------------------

META: dict = {}
LISTINGS: List[dict] = []
EMB: Optional[np.ndarray] = None  # [N, DIM] float32, rows ~unit length
QUALITY: Optional[np.ndarray] = None
EMBEDDER: Optional[Embedder] = None


def quality(listing: dict) -> float:
    rating = min(max(((listing.get("rating") or 4) - 4) / 1, 0), 1)
    volume = min(math.log10((listing.get("reviews") or 0) + 1) / 3, 1)
    return (rating + volume) / 2


def load_index():
    global META, LISTINGS, EMB, QUALITY
    with open(os.path.join(DATA_DIR, "listings.json"), encoding="utf-8") as f:
        META = json.load(f)
    cities = META["cities"]
    LISTINGS = [{**l, "cityName": cities[l["city"]]["name"]} for l in META["listings"]]
    raw = np.fromfile(os.path.join(DATA_DIR, "embeddings.bin"), dtype=np.int8)
    EMB = raw.reshape(len(LISTINGS), META["dim"]).astype(np.float32) / 127.0
    QUALITY = np.array([quality(l) for l in LISTINGS], dtype=np.float32)


def make_embedder() -> Embedder:
    if USE_HF_API:
        return HFInferenceAPIEmbedder(MODEL_NAME, HF_TOKEN)
    try:
        return HFLocalEmbedder(MODEL_NAME)
    except Exception:
        # Fall back to the API if torch/transformers aren't installed and a token is present
        if HF_TOKEN:
            return HFInferenceAPIEmbedder(MODEL_NAME, HF_TOKEN)
        raise


@asynccontextmanager
async def lifespan(_: FastAPI):
    global EMBEDDER
    load_index()
    EMBEDDER = make_embedder()
    yield


app = FastAPI(title="Airbnb Finder", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])

# ----------------------------
# API
# ----------------------------

class Filters(BaseModel):
    city: Optional[str] = None
    minPrice: Optional[float] = None
    maxPrice: Optional[float] = None
    guests: Optional[int] = None
    bedrooms: Optional[int] = None
    roomType: Optional[str] = None


class SearchRequest(BaseModel):
    query: str = ""
    top_k: Optional[int] = None
    filters: Filters = Filters()


def matches(l: dict, f: Filters) -> bool:
    if f.city and l["cityName"] != f.city:
        return False
    if f.maxPrice and l["price"] > f.maxPrice:
        return False
    if f.minPrice and l["price"] < f.minPrice:
        return False
    if f.guests and (l.get("guests") or 0) < f.guests:
        return False
    if f.bedrooms and (l.get("bedrooms") or 0) < f.bedrooms:
        return False
    if f.roomType and l["roomType"] != f.roomType:
        return False
    return True


@app.get("/health")
def health():
    return {"status": "ok", "listings": len(LISTINGS)}


@app.get("/api/meta")
def meta():
    return {"cities": META["cities"], "generated": META["generated"]}


@app.post("/api/search")
def search(req: SearchRequest):
    k = max(1, min(TOP_K_DEFAULT if req.top_k is None else req.top_k, 200))
    query = req.query.strip() or GENERIC_QUERY
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="Query is too long (max 500 characters)")

    idx = np.array([i for i, l in enumerate(LISTINGS) if matches(l, req.filters)], dtype=np.int64)
    if idx.size == 0:
        return {"results": []}

    q = EMBEDDER.embed([f"query: {query}"])[0]
    scores = EMB[idx] @ q + QUALITY_WEIGHT * QUALITY[idx]
    top = np.argsort(-scores)[:k]
    return {"results": [{**LISTINGS[idx[t]], "score": float(scores[t])} for t in top]}
