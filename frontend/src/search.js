// Search engines. Both expose the same interface:
//   load(onProgress) -> { cities, generated }   onProgress receives 0..1
//   search(query, filters, limit) -> listings with a `score`
//
// The browser engine (default) runs the E5 model with transformers.js and
// ranks against embeddings precomputed by scripts/build-data.mjs, so the site
// needs no server. The API engine delegates to the FastAPI backend.

const MODEL_ID = 'Xenova/e5-small-v2'
const DATA_URL = import.meta.env.BASE_URL

// Small prior so a well-reviewed place wins a near-tie in similarity. E5
// similarities between good matches differ by ~0.01-0.05.
const QUALITY_WEIGHT = 0.02
function quality(l) {
  const rating = Math.min(Math.max(((l.rating ?? 4) - 4) / 1, 0), 1)
  const volume = Math.min(Math.log10((l.reviews ?? 0) + 1) / 3, 1)
  return (rating + volume) / 2
}

export function matchesFilters(l, f, cityName) {
  if (f.city && cityName !== f.city) return false
  if (f.maxPrice && l.price > f.maxPrice) return false
  if (f.minPrice && l.price < f.minPrice) return false
  if (f.guests && (l.guests ?? 0) < f.guests) return false
  if (f.bedrooms && (l.bedrooms ?? 0) < f.bedrooms) return false
  if (f.roomType && l.roomType !== f.roomType) return false
  return true
}

export function createBrowserEngine() {
  let ready = null
  let lastQuery = null // [text, vector]: filter changes re-rank without re-embedding

  function load(onProgress = () => {}) {
    if (!ready) ready = init(onProgress)
    return ready.then(({ meta }) => ({ cities: meta.cities, generated: meta.generated }))
  }

  function init(onProgress) {
    const files = {}
    const promise = (async () => {
      const [{ pipeline }, meta, embBuf] = await Promise.all([
        import('@huggingface/transformers'),
        fetch(`${DATA_URL}listings.json`).then(okJson),
        fetch(`${DATA_URL}embeddings.bin`).then(okBuffer),
      ])
      const extractor = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.total) return
          files[p.file] = p
          const all = Object.values(files)
          onProgress(all.reduce((s, f) => s + f.loaded, 0) / all.reduce((s, f) => s + f.total, 0))
        },
      })
      return { extractor, meta, emb: new Int8Array(embBuf) }
    })()
    // Allow a retry after a failed load (e.g. network error)
    promise.catch(() => { ready = null })
    return promise
  }

  async function search(query, filters = {}, limit = 96) {
    await load()
    const { extractor, meta, emb } = await ready
    const { dim, listings, cities } = meta
    const text = `query: ${query.trim()}`
    if (lastQuery?.[0] !== text) {
      const out = await extractor([text], { pooling: 'mean', normalize: true })
      lastQuery = [text, out.data]
    }
    const q = lastQuery[1]

    const scored = []
    for (let i = 0; i < listings.length; i++) {
      const l = listings[i]
      if (!matchesFilters(l, filters, cities[l.city].name)) continue
      let dot = 0
      for (let k = 0, o = i * dim; k < dim; k++) dot += emb[o + k] * q[k]
      scored.push({ ...l, cityName: cities[l.city].name, score: dot / 127 + QUALITY_WEIGHT * quality(l) })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  return { load, search }
}

export function createApiEngine(base) {
  return {
    async load() {
      return okJson(await fetch(`${base}/api/meta`))
    },
    async search(query, filters = {}, limit = 96) {
      const res = await fetch(`${base}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, top_k: limit, filters }),
      })
      return (await okJson(res)).results
    },
  }
}

async function okJson(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || `${res.url} responded with ${res.status}`)
  return data
}

async function okBuffer(res) {
  if (!res.ok) throw new Error(`${res.url} responded with ${res.status}`)
  return res.arrayBuffer()
}
