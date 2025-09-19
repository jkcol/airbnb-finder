
# Airbnb Finder (Hugging Face LLM)

A full-stack demo web application that lets users describe the Airbnb they want in natural language (e.g., *"a modern loft in NYC with fast Wi‑Fi and close to public transit"*) and returns the best matching listings.

- **Backend:** FastAPI (Python)
- **LLM Integration:** Hugging Face (local via `transformers` *or* remote via Hugging Face Inference API)
- **Frontend:** React (Vite)
- **Data:** Mock dataset in `data/listings.json`

---

## Features
- Natural language search over Airbnb-style listings.
- Rankings computed with sentence embeddings from a Hugging Face model (`intfloat/e5-small-v2`).
- Two modes:
  - **Local embedding** (default): loads the model with `transformers` + `torch`.
  - **Remote embedding**: uses **Hugging Face Inference API** if you set `HUGGINGFACE_API_TOKEN` and `USE_HF_API=1`.
- Responsive UI with Airbnb-like cards (image, title, price, location, description, amenities).

---

## Quickstart

### Prerequisites
- **Python** 3.9+ (tested on 3.10/3.11)
- **Node.js** 18+ and **npm** 9+

### 1) Backend Setup
```bash
# From the project root
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate

pip install -r requirements.txt

# Option A: Local model (default) — no token required
# Just run the server:
uvicorn backend.main:app --reload --port 8000

# Option B: Use Hugging Face Inference API (lighter install; can skip torch)
# (If you prefer, uninstall torch to save space and use the remote API.)
export HUGGINGFACE_API_TOKEN=YOUR_HF_TOKEN
export USE_HF_API=1
uvicorn backend.main:app --reload --port 8000
```

> **Note:** If you use the remote API, requests are sent to `https://api-inference.huggingface.co/pipeline/feature-extraction/{model}`.

### 2) Frontend Setup
```bash
# From the project root
npm install   # installs frontend deps via postinstall
npm start     # starts Vite dev server at http://localhost:5173
```

Open **http://localhost:5173**. The frontend will call the backend at **http://localhost:8000**.

---

## Configuration
You can customize behavior using environment variables (for the backend):

- `USE_HF_API` — set to `1` to use the Hugging Face Inference API; otherwise local embeddings are used.
- `HUGGINGFACE_API_TOKEN` — your token for the Inference API (required if `USE_HF_API=1`).
- `MODEL_NAME` — defaults to `intfloat/e5-small-v2`.
- `TOP_K_DEFAULT` — default number of results (defaults to `10`).

Create a `.env` file in the project root if you'd like (the backend loads it):
```env
USE_HF_API=0
HUGGINGFACE_API_TOKEN=
MODEL_NAME=intfloat/e5-small-v2
TOP_K_DEFAULT=10
```

---

## Project Structure
```
/ frontend        # React + Vite frontend
/ backend         # FastAPI backend (LLM + ranking)
/ data            # mock dataset (JSON)
README.md
requirements.txt
package.json
```

---

## API
- `POST /api/search`
  - **Body:** `{ "query": string, "top_k"?: number }
  - **Response:** `{ results: Array< Listing & { score: number } > }`

- `GET /health` → `{ status: "ok" }`

---

## Notes
- The demo uses the **E5** family of embedding models (`intfloat/e5-small-v2`) for semantic search. For best results, queries are prefixed with `query:` and documents with `passage:` as recommended by the model authors.
- If you're on a constrained machine, prefer the Inference API mode (`USE_HF_API=1`) to avoid installing `torch` locally.

---

## License
MIT (for this demo code). Unsplash images are used via hotlinks and are subject to Unsplash licensing.
