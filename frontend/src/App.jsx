
import React, { useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

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

  const search = async () => {
    if (!q.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, top_k: 12 })
      })
      const data = await res.json()
      setResults(data.results || [])
    } catch (err) {
      alert('Search failed: ' + err)
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
        </div>
      </div>

      <div className="container">
        {results.length === 0 ? (
          <p className="small">Type a natural language description and press Search. Results will appear here.</p>
        ) : (
          <div className="grid">
            {results.map((item) => (
              <Card item={item} key={item.id} />
            ))}
          </div>
        )}
      </div>

      <div className="footer">Built with FastAPI + React + Hugging Face</div>
    </>
  )
}
