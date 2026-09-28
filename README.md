# Airbnb Finder

Search real Airbnb listings by describing what you want in plain English, e.g. *"a quiet 2 bedroom flat in London for 4 people under £250 with a garden"*.

**Live site:** https://jkcol.github.io/airbnb-finder/

- **12,000 real listings** across 12 cities (New York, Los Angeles, San Francisco, Chicago, Austin, London, Paris, Barcelona, Rome, Lisbon, Amsterdam, Tokyo). Each result links to the actual listing on airbnb.com.
- **Semantic search** with sentence embeddings (`intfloat/e5-small-v2`): it matches on meaning (vibe, neighborhood, amenities), not just keywords.
- **Automatic filters**: city, budget, group size, bedrooms, and room type mentioned in the query become filters you can see and adjust.
- **Private and serverless**: the model runs in your browser with transformers.js. Queries never leave your device, and the site is plain static files on GitHub Pages.
- Shareable URLs, sorting by price or rating, and a mobile-friendly layout with dark mode.

> Listing data comes from [Inside Airbnb](https://insideairbnb.com) under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is a periodic snapshot, so prices and
> availability can differ from Airbnb today. This project is not affiliated with or endorsed by Airbnb.

## How it works

```
 build time (scripts/build-data.mjs)              in the browser (frontend/)
 ───────────────────────────────────              ─────────────────────────────────────
 Inside Airbnb CSVs ──► filter & select   ─┐      query ──► parseQuery ──► filters
   (active, reviewed, English, top 1000    │        │
    per city)                              │        └──► E5 model (transformers.js, q8)
                 │                         │                │  "query: …"
                 ▼                         │                ▼
 E5 model (Node, q8) "passage: …"          │      dot product vs. all listing vectors
                 │                         │      + small rating/review prior, filtered
                 ▼                         │                │
 data/listings.json + data/embeddings.bin ─┴────────────────┘──► ranked cards
       (metadata)       (int8, 12k × 384)
```

Listings are embedded once, at build time, with the same quantized ONNX model the browser runs (`Xenova/e5-small-v2`), so query and listing vectors share one space. The browser downloads the model (~35 MB, then cached) plus the index (~8 MB), and each search is a single model call and a pass over 12k vectors, which takes milliseconds.

## Quickstart

Requires Node.js 18+.

```bash
npm install   # installs frontend deps via postinstall
npm start     # http://localhost:5173
npm test      # query parser tests
```

## Refreshing the data

The index in `data/` is committed. To rebuild it from the latest Inside Airbnb snapshots:

```bash
npm run build-data                       # all cities, ~25 min on a laptop CPU
cd scripts && CITIES=london,paris PER_CITY=500 npm run build-data   # a subset
```

Cities are configured in `ALL_CITIES` in [`scripts/build-data.mjs`](scripts/build-data.mjs); any city on the [Inside Airbnb data page](https://insideairbnb.com/get-the-data/) can be added by its URL slug. The model is English-only, so non-English listings are skipped.

The [`Refresh listing data`](.github/workflows/refresh-data.yml) workflow rebuilds the index monthly (and on demand from the Actions tab), commits it if anything changed, and redeploys the site.

## Deployment

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds the frontend and publishes it to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Optional: FastAPI backend

The site doesn't need a server, but `backend/` serves the same search over HTTP, with the same index, filters and ranking. That's useful for integrating with other apps.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-local.txt      # includes torch + transformers
uvicorn backend.main:app --port 8000

# or, without torch, using the Hugging Face Inference API:
pip install -r requirements.txt
HUGGINGFACE_API_TOKEN=hf_... USE_HF_API=1 uvicorn backend.main:app --port 8000
```

Point the frontend at it with `VITE_API_BASE=http://localhost:8000 npm start`.

| Endpoint | Description |
| --- | --- |
| `POST /api/search` | Body: `{ "query": string, "top_k"?: number, "filters"?: { city, minPrice, maxPrice, guests, bedrooms, roomType } }` → `{ results: Listing[] }` sorted by `score` |
| `GET /api/meta` | Cities, snapshot dates, listing counts |
| `GET /health` | `{ status: "ok", listings: number }` |

Backend environment variables (a `.env` file in the project root also works): `USE_HF_API`, `HUGGINGFACE_API_TOKEN`, `MODEL_NAME` (default `intfloat/e5-small-v2`), `TOP_K_DEFAULT` (24), `HF_API_URL`, `CORS_ORIGINS` (comma-separated, default `*`).

## Project structure

```
frontend/   React + Vite site; src/search.js (engines), src/queryParser.js (filters)
scripts/    build-data.mjs: downloads Inside Airbnb data and builds the index
data/       generated index served with the site (listings.json, embeddings.bin)
backend/    optional FastAPI server
.github/    Pages deploy + monthly data refresh
```

## License

Code: [MIT](LICENSE). Listing data: Inside Airbnb, CC BY 4.0. Listing photos are hotlinked from Airbnb and belong to their owners.
