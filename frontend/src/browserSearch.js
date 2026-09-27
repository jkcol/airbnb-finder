// In-browser semantic search: runs the same E5 embedding model as the FastAPI
// backend, via transformers.js (ONNX Runtime Web), so the site needs no server.
import { pipeline } from '@huggingface/transformers'
import listings from '../../data/listings.json'

// ONNX export of intfloat/e5-small-v2 published for transformers.js
const MODEL_ID = import.meta.env.VITE_BROWSER_MODEL || 'Xenova/e5-small-v2'

// Python's str() of a float keeps a trailing ".0"; mirror it so document text
// matches backend/main.py:build_document_text exactly.
const pyNum = (n) => (typeof n === 'number' && Number.isInteger(n) ? n.toFixed(1) : String(n))

function buildDocumentText(item) {
  const ams = (item.amenities || []).join(', ')
  return (
    `${item.title || ''}. ${item.description || ''} ` +
    `Located in ${item.location || ''}. Amenities: ${ams}. ` +
    `Fits ${item.guests ?? ''} guests. Price $${pyNum(item.price)}/night.`
  )
}

let readyPromise = null

// Loads the model and embeds all listings once. onProgress receives 0..1 while
// model files download.
export function loadIndex(onProgress = () => {}) {
  if (readyPromise) return readyPromise
  const files = {}
  readyPromise = (async () => {
    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return
        files[p.file] = { loaded: p.loaded, total: p.total }
        const all = Object.values(files)
        const loaded = all.reduce((s, f) => s + f.loaded, 0)
        const total = all.reduce((s, f) => s + f.total, 0)
        onProgress(loaded / total)
      },
    })
    const embed = async (texts) =>
      (await extractor(texts, { pooling: 'mean', normalize: true })).tolist()
    const docEmb = await embed(listings.map((x) => `passage: ${buildDocumentText(x)}`))
    return { embed, docEmb }
  })()
  // Allow a retry after a failed load (e.g. network error)
  readyPromise.catch(() => { readyPromise = null })
  return readyPromise
}

export async function searchListings(query, topK = 10) {
  const { embed, docEmb } = await loadIndex()
  const [q] = await embed([`query: ${query.trim()}`])
  // Vectors are L2-normalized, so the dot product is cosine similarity
  return docEmb
    .map((d, i) => ({ ...listings[i], score: d.reduce((s, v, j) => s + v * q[j], 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(topK, 50)))
}
