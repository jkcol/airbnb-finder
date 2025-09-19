
import os
import json
import math
from typing import List, Optional

import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel
import torch
from dotenv import load_dotenv

# Load env vars from .env if present
load_dotenv()

USE_HF_API = os.getenv("USE_HF_API", "0").lower() in {"1", "true", "yes"}
HF_TOKEN = os.getenv("HUGGINGFACE_API_TOKEN", "").strip()
MODEL_NAME = os.getenv("MODEL_NAME", "intfloat/e5-small-v2")
TOP_K_DEFAULT = int(os.getenv("TOP_K_DEFAULT", "10"))

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "listings.json")
DATA_PATH = os.path.abspath(DATA_PATH)

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
        self.model_name = model_name
        self.token = token
        self.endpoint = f"https://api-inference.huggingface.co/pipeline/feature-extraction/{model_name}"
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def embed(self, texts: List[str]) -> np.ndarray:
        payload = {"inputs": texts}
        resp = requests.post(self.endpoint, headers=self.headers, json=payload, timeout=60)
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail=f"HF Inference API error: {resp.status_code} {resp.text}")
        arr = np.array(resp.json(), dtype=np.float32)
        # Some models may return a list of token embeddings; if so, mean-pool
        if arr.ndim == 3:
            arr = arr.mean(axis=1)
        # L2 normalize
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-12
        return arr / norms

class HFLocalEmbedder(Embedder):
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.eval()
        self.model.to(self.device)

    @torch.no_grad()
    def embed(self, texts: List[str]) -> np.ndarray:
        # Tokenize
        encoded = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        encoded = {k: v.to(self.device) for k, v in encoded.items()}
        outputs = self.model(**encoded)
        # Mean pooling with attention mask
        last_hidden = outputs.last_hidden_state  # [B, T, H]
        mask = encoded["attention_mask"].unsqueeze(-1)  # [B, T, 1]
        masked = last_hidden * mask
        sum_emb = masked.sum(dim=1)
        lengths = mask.sum(dim=1).clamp(min=1e-9)
        sent_emb = sum_emb / lengths
        sent_emb = sent_emb / (sent_emb.norm(dim=1, keepdim=True) + 1e-12)
        return sent_emb.cpu().numpy()

# ----------------------------
# Data models
# ----------------------------

class Listing(BaseModel):
    id: str
    title: str
    description: str
    location: str
    price: float
    guests: int
    amenities: List[str]
    image_url: str

class SearchRequest(BaseModel):
    query: str
    top_k: Optional[int] = None

class SearchResult(BaseModel):
    results: List[Listing]

# ----------------------------
# App init
# ----------------------------

app = FastAPI(title="Airbnb Finder (HF LLM)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
LISTINGS: List[dict] = []
LISTING_TEXTS: List[str] = []
LISTING_EMB: Optional[np.ndarray] = None
EMBEDDER: Optional[Embedder] = None


def build_document_text(item: dict) -> str:
    ams = ", ".join(item.get("amenities", []))
    return (
        f"{item.get('title', '')}. {item.get('description', '')} "
        f"Located in {item.get('location', '')}. Amenities: {ams}. "
        f"Fits {item.get('guests', '')} guests. Price ${item.get('price', '')}/night."
    )


def cosine_top_k(query_vec: np.ndarray, doc_mat: np.ndarray, k: int):
    # Assumes already L2-normalized
    scores = (doc_mat @ query_vec.reshape(-1, 1)).ravel()
    idx = np.argpartition(-scores, kth=min(k, len(scores)-1))[:k]
    idx = idx[np.argsort(-scores[idx])]
    return idx, scores[idx]


@app.on_event("startup")
def _startup():
    global LISTINGS, LISTING_TEXTS, LISTING_EMB, EMBEDDER

    # Load data
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        LISTINGS = json.load(f)

    # Prepare texts with E5 doc prefix
    LISTING_TEXTS = [f"passage: {build_document_text(x)}" for x in LISTINGS]

    # Initialize embedder
    if USE_HF_API:
        EMBEDDER = HFInferenceAPIEmbedder(MODEL_NAME, HF_TOKEN)
    else:
        try:
            EMBEDDER = HFLocalEmbedder(MODEL_NAME)
        except Exception as e:
            # Fallback to API if local fails and token is present
            if HF_TOKEN:
                EMBEDDER = HFInferenceAPIEmbedder(MODEL_NAME, HF_TOKEN)
            else:
                raise e

    # Precompute listing embeddings
    # Batch embed for efficiency
    batch_size = 16
    emb_list = []
    for i in range(0, len(LISTING_TEXTS), batch_size):
        batch = LISTING_TEXTS[i:i+batch_size]
        emb = EMBEDDER.embed(batch)
        emb_list.append(emb)
    LISTING_EMB = np.vstack(emb_list).astype(np.float32)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/search")
def search(req: SearchRequest):
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")
    k = req.top_k or TOP_K_DEFAULT
    k = max(1, min(k, 50))

    query_text = f"query: {req.query.strip()}"
    q_emb = EMBEDDER.embed([query_text])[0]

    idx, scores = cosine_top_k(q_emb, LISTING_EMB, k)
    ranked = []
    for i, sc in zip(idx, scores):
        item = dict(LISTINGS[i])
        item["score"] = float(sc)
        ranked.append(item)

    return {"results": ranked}
