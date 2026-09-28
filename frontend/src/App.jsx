import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createApiEngine, createBrowserEngine } from './search'
import { parseQuery } from './queryParser'

// Set VITE_API_BASE (e.g. http://localhost:8000) to search via the FastAPI
// backend; otherwise the model runs in the browser and no server is needed.
const API_BASE = import.meta.env.VITE_API_BASE
const engine = API_BASE ? createApiEngine(API_BASE) : createBrowserEngine()

const PAGE = 24
const EXAMPLES = [
  'Bright loft in Brooklyn with a workspace and fast wifi',
  'Beach house in LA for 6 people with a pool',
  'Quiet flat in Paris near cafes under €150',
  'Cozy private room in London close to the tube',
  'Family-friendly 3 bedroom house in Austin with a backyard',
  'Apartment in Lisbon with a view of the river',
]
const ROOM_TYPES = { 'Entire home/apt': 'Entire place', 'Private room': 'Private room', 'Hotel room': 'Hotel room', 'Shared room': 'Shared room' }
const SORTS = {
  match: { label: 'Best match', fn: null },
  priceAsc: { label: 'Price: low to high', fn: (a, b) => a.price - b.price },
  priceDesc: { label: 'Price: high to low', fn: (a, b) => b.price - a.price },
  rating: { label: 'Top rated', fn: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews },
}
const FILTER_KEYS = ['city', 'guests', 'bedrooms', 'minPrice', 'maxPrice', 'roomType']
const NUMERIC = new Set(['guests', 'bedrooms', 'minPrice', 'maxPrice'])

// q, sort and filters live in the URL so searches can be shared and bookmarked.
function readUrl() {
  const p = new URLSearchParams(window.location.search)
  const filters = {}
  for (const k of FILTER_KEYS) {
    const v = p.get(k)
    if (v) filters[k] = NUMERIC.has(k) ? Number(v) : v
  }
  return { q: p.get('q') || '', sort: SORTS[p.get('sort')] ? p.get('sort') : 'match', filters }
}

function writeUrl(q, filters, sort) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k])
  if (sort !== 'match') p.set('sort', sort)
  const qs = p.toString()
  window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
}

const clean = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null && !Number.isNaN(v)))

// Airbnb's image CDN only resizes under /im/; originals can be several MB.
const thumbnail = (url) => `${url.replace('muscache.com/pictures/', 'muscache.com/im/pictures/')}?im_w=720`

function formatPrice(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${Math.round(amount)}`
  }
}

// Prices are in each city's local currency, so show which one once a city is picked.
function currencySymbol(currency) {
  if (!currency) return ''
  const part = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')
  return ` (${part?.value || currency})`
}

function Filters({ filters, cities, sort, onChange, onSort, onClear }) {
  const set = (k) => (e) => {
    const v = e.target.value
    onChange(clean({ ...filters, [k]: NUMERIC.has(k) ? (v === '' ? '' : Number(v)) : v }))
  }
  const active = Object.keys(filters).length > 0
  return (
    <div className="filters">
      <label>
        <span>City</span>
        <select value={filters.city || ''} onChange={set('city')}>
          <option value="">All cities</option>
          {cities.map((c) => <option key={c.slug} value={c.name}>{c.name}</option>)}
        </select>
      </label>
      <label>
        <span>Guests</span>
        <select value={filters.guests || ''} onChange={set('guests')}>
          <option value="">Any</option>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{n === 16 ? '+' : ''}</option>)}
        </select>
      </label>
      <label>
        <span>Bedrooms</span>
        <select value={filters.bedrooms || ''} onChange={set('bedrooms')}>
          <option value="">Any</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}+</option>)}
        </select>
      </label>
      <label>
        <span>Type</span>
        <select value={filters.roomType || ''} onChange={set('roomType')}>
          <option value="">Any</option>
          {Object.entries(ROOM_TYPES).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      <label className="price">
        <span>Max{currencySymbol(cities.find((c) => c.name === filters.city)?.currency)} / night</span>
        <input type="number" min="0" step="10" inputMode="numeric" placeholder="Any" value={filters.maxPrice ?? ''} onChange={set('maxPrice')} />
      </label>
      <label>
        <span>Sort</span>
        <select value={sort} onChange={(e) => onSort(e.target.value)}>
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </label>
      {active && <button type="button" className="link" onClick={onClear}>Clear filters</button>}
    </div>
  )
}

function Card({ item }) {
  const [imgOk, setImgOk] = useState(true)
  const details = [
    ROOM_TYPES[item.roomType] || item.roomType,
    item.bedrooms != null && `${item.bedrooms} bedroom${item.bedrooms === 1 ? '' : 's'}`,
    `sleeps ${item.guests}`,
  ].filter(Boolean)
  return (
    <a className="card" href={`https://www.airbnb.com/rooms/${item.id}`} target="_blank" rel="noopener noreferrer">
      <div className="photo">
        {imgOk
          ? <img src={thumbnail(item.image)} alt="" loading="lazy" onError={() => setImgOk(false)} />
          : <div className="noimg">No photo</div>}
        {item.superhost && <span className="badge">Superhost</span>}
      </div>
      <div className="card-body">
        <div className="row">
          <span className="where">{item.hood && !/^\d+$/.test(item.hood) ? `${item.hood}, ` : ''}{item.cityName}</span>
          {item.rating != null && <span className="rating">★ {item.rating.toFixed(2)} <span className="muted">({item.reviews})</span></span>}
        </div>
        <h3>{item.name}</h3>
        <div className="muted">{details.join(' · ')}</div>
        <p className="desc">{item.description}</p>
        {item.amenities.length > 0 && (
          <div className="amenities">
            {item.amenities.slice(0, 4).map((a) => <span className="tag" key={a}>{a}</span>)}
          </div>
        )}
        <div className="price"><strong>{formatPrice(item.price, item.currency)}</strong> night</div>
      </div>
    </a>
  )
}

export default function App() {
  const initial = useMemo(readUrl, [])
  const [q, setQ] = useState(initial.q)
  const [filters, setFilters] = useState(initial.filters)
  const [sort, setSort] = useState(initial.sort)
  // The search that produced the current results; changing it runs a search.
  const [submitted, setSubmitted] = useState(initial.q || Object.keys(initial.filters).length ? { q: initial.q, filters: initial.filters } : null)
  const [results, setResults] = useState([])
  const [shown, setShown] = useState(PAGE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null) // { cities, generated } once loaded
  const [loadError, setLoadError] = useState('')
  const [progress, setProgress] = useState(0)
  const requestId = useRef(0)

  const loadEngine = () => {
    setLoadError('')
    engine.load(setProgress).then(setMeta).catch((err) => setLoadError(err.message))
  }
  useEffect(loadEngine, [])

  useEffect(() => {
    if (!submitted) return
    const id = ++requestId.current
    setLoading(true)
    setError('')
    // With only filters and no text, rank by a generic "good stay" query.
    engine.search(submitted.q || 'a comfortable, clean, well-located place to stay', submitted.filters)
      .then((r) => { if (id === requestId.current) { setResults(r); setShown(PAGE) } })
      .catch((err) => { if (id === requestId.current) { setResults([]); setError(err.message) } })
      .finally(() => { if (id === requestId.current) setLoading(false) })
  }, [submitted])

  useEffect(() => { writeUrl(submitted?.q || '', filters, sort) }, [submitted, filters, sort])

  const cities = meta?.cities || []

  const runSearch = async (text = q) => {
    // City names come from the index, so wait for it if it's still loading.
    const known = meta || (await engine.load().catch(() => null))
    const parsed = parseQuery(text, (known?.cities || []).map((c) => c.name))
    const next = { ...filters, ...parsed }
    setQ(text)
    setFilters(next)
    setSubmitted({ q: text.trim(), filters: next })
  }

  const changeFilters = (next) => {
    setFilters(next)
    if (submitted) setSubmitted({ q: submitted.q, filters: next })
  }

  const sorted = useMemo(
    () => (SORTS[sort].fn ? [...results].sort(SORTS[sort].fn) : results),
    [results, sort]
  )

  const totalListings = cities.reduce((s, c) => s + c.count, 0)

  return (
    <>
      <header className="header">
        <div className="container">
          <a className="brand" href="./">Airbnb Finder <span className="muted">· natural-language stay search</span></a>
          <form className="searchbar" onSubmit={(e) => { e.preventDefault(); runSearch() }}>
            <input
              aria-label="Describe the place you want"
              placeholder="Describe your ideal stay, e.g. a sunny loft in Brooklyn for 2 under $200"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button disabled={loading} type="submit">{loading ? 'Searching…' : 'Search'}</button>
          </form>
          <Filters
            filters={filters}
            cities={cities}
            sort={sort}
            onChange={changeFilters}
            onSort={setSort}
            onClear={() => changeFilters({})}
          />
          {!meta && !loadError && (
            <p className="status">
              {API_BASE
                ? 'Connecting to the search server…'
                : <>Loading the search model in your browser{progress > 0 && progress < 1 ? ` (${Math.round(progress * 100)}%)` : ''}… this happens once, then it's cached.</>}
            </p>
          )}
          {loadError && (
            <p className="status error">
              Couldn't load search: {loadError}. <button className="link" onClick={loadEngine}>Try again</button>
            </p>
          )}
        </div>
      </header>

      <main className="container">
        {error ? (
          <p className="error">Search failed: {error}</p>
        ) : !submitted ? (
          <section className="intro">
            <h1>Describe the place. We'll find the listings.</h1>
            <p className="muted">
              Search {totalListings ? totalListings.toLocaleString() : 'thousands of'} real Airbnb listings
              {cities.length > 1 ? ` across ${cities.length} cities` : ''} by what you actually want — the vibe,
              the neighborhood, the amenities. Mentions of a city, budget, group size, or bedrooms become filters automatically.
            </p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => runSearch(ex)}>{ex}</button>
              ))}
            </div>
          </section>
        ) : loading && results.length === 0 ? (
          <p className="muted">{meta ? 'Searching…' : 'Searching as soon as the model finishes loading…'}</p>
        ) : results.length === 0 ? (
          <p className="muted">No listings match these filters. Try raising the price limit or clearing a filter.</p>
        ) : (
          <>
            <p className="muted summary">
              Top {results.length} matches{submitted.q ? <> for “{submitted.q}”</> : null}
              {sort !== 'match' && `, sorted by ${SORTS[sort].label.toLowerCase()}`}
            </p>
            <div className={`grid${loading ? ' stale' : ''}`}>
              {sorted.slice(0, shown).map((item) => <Card item={item} key={item.id} />)}
            </div>
            {shown < sorted.length && (
              <div className="more">
                <button type="button" onClick={() => setShown(shown + PAGE)}>Show more</button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="footer container">
        <p>
          Listing data from <a href="https://insideairbnb.com" target="_blank" rel="noopener noreferrer">Inside Airbnb</a>
          {' '}(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>)
          {cities.length > 0 && `, snapshots from ${[...new Set(cities.map((c) => c.date.slice(0, 7)))].sort().join(', ')}`}.
          {' '}Prices are nightly rates at snapshot time in local currency; check Airbnb for current prices and availability.
        </p>
        <p>
          Not affiliated with or endorsed by Airbnb.
          {!API_BASE && ' Search runs entirely in your browser — your queries never leave your device.'}
          {' '}<a href="https://github.com/jkcol/airbnb-finder" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
        </p>
      </footer>
    </>
  )
}
