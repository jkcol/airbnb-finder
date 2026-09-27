
import React, { useEffect, useState } from 'react'

// Set VITE_API_BASE (e.g. http://localhost:8000) to search via the FastAPI
// backend; otherwise the model runs in the browser and no server is needed.
const API_BASE = import.meta.env.VITE_API_BASE
const browserSearch = API_BASE ? null : import('./browserSearch')

async function searchApi(query, topK) {
  const res = await fetch(`${API_BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.detail || `Server responded with ${res.status}`)
  }
  return data.results || []
}

async function searchBrowser(query, topK) {
  const { searchListings } = await browserSearch
  return searchListings(query, topK)
}

function SearchBar({ value, onChange, onSubmit, loading }) {
  return (
    <form className="searchbar" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input
        placeholder="Try: a modern loft in NYC with fast Wi‑Fi near the subway"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button disabled={loading} type="submit">{loading ? 'Searching…' : 'Search'}</button>
    </form>
  )
}

function Card({ item }) {
  return (
    <div className="card">
      <img src={item.image_url} alt={item.title} />
      <div className="card-body">
        <div className="card-title">
          <h3>{item.title}</h3>
          <div className="price">${item.price}<span className="small">/night</span></div>
        </div>
        <div className="location">{item.location} • Sleeps {item.guests}</div>
        <div className="desc">{item.description}</div>
        <div className="amenities">
          {item.amenities.slice(0, 6).map((a, idx) => <span className="tag" key={idx}>{a}</span>)}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  // Browser mode: null while the model loads, then 'ready' or an error message
  const [modelStatus, setModelStatus] = useState(API_BASE ? 'ready' : null)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!browserSearch) return
    browserSearch
      .then(({ loadIndex }) => loadIndex(setProgress))
      .then(() => setModelStatus('ready'))
      .catch((err) => setModelStatus(`Could not load the search model: ${err.message}`))
  }, [])

  const search = async () => {
    if (!q.trim()) return
    setLoading(true)
    setError('')
    try {
      const run = API_BASE ? searchApi : searchBrowser
      setResults(await run(q, 12))
      setSearched(true)
      if (!API_BASE) setModelStatus('ready')
    } catch (err) {
      setResults([])
      setError(`Search failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="header">
        <div className="container">
          <div className="brand">Airbnb Finder</div>
          <SearchBar value={q} onChange={setQ} onSubmit={search} loading={loading} />
          {modelStatus === null && (
            <p className="small status">
              {progress < 1
                ? `Loading search model in your browser${progress > 0 ? ` (${Math.round(progress * 100)}%)` : ''}… first visit only, then it's cached.`
                : 'Indexing listings…'}
            </p>
          )}
          {modelStatus && modelStatus !== 'ready' && <p className="small status">{modelStatus}</p>}
        </div>
      </div>

      <div className="container">
        {error ? (
          <p className="error">{error}</p>
        ) : results.length === 0 ? (
          <p className="small">
            {searched
              ? 'No listings matched your search.'
              : 'Type a natural language description and press Search. Results will appear here.'}
          </p>
        ) : (
          <div className="grid">
            {results.map((item) => (
              <Card item={item} key={item.id} />
            ))}
          </div>
        )}
      </div>

      <div className="footer">
        {API_BASE
          ? 'Built with FastAPI + React + Hugging Face'
          : 'Built with React + Hugging Face transformers.js (search runs in your browser)'}
      </div>
    </>
  )
}
