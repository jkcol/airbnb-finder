// Builds the search index shipped with the site:
//   data/listings.json   listing metadata + city list
//   data/embeddings.bin  int8 [N x DIM] L2-normalized passage embeddings
//
// Source: Inside Airbnb (https://insideairbnb.com), CC BY 4.0. The latest
// snapshot URL for each city is discovered from the "get the data" page, so
// re-running this script refreshes the index.
//
// Usage: cd scripts && npm install && npm run build-data
//   PER_CITY=1000  listings kept per city
//   CITIES=london,paris  only rebuild a subset (others are dropped)
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'csv-parse'
import { pipeline } from '@huggingface/transformers'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache')
const OUT = join(ROOT, 'data')

// Must match the browser's model (frontend/src/search.js) so query and passage
// vectors live in the same space.
const MODEL_ID = 'Xenova/e5-small-v2'
const DIM = 384
const PER_CITY = Number(process.env.PER_CITY || 1000)

// slug is Inside Airbnb's URL path segment; currency is a fallback for rows
// whose price quote doesn't say.
const ALL_CITIES = [
  { slug: 'new-york-city', name: 'New York', currency: 'USD' },
  { slug: 'los-angeles', name: 'Los Angeles', currency: 'USD' },
  { slug: 'san-francisco', name: 'San Francisco', currency: 'USD' },
  { slug: 'chicago', name: 'Chicago', currency: 'USD' },
  { slug: 'austin', name: 'Austin', currency: 'USD' },
  { slug: 'london', name: 'London', currency: 'GBP' },
  { slug: 'paris', name: 'Paris', currency: 'EUR' },
  { slug: 'barcelona', name: 'Barcelona', currency: 'EUR' },
  { slug: 'rome', name: 'Rome', currency: 'EUR' },
  { slug: 'lisbon', name: 'Lisbon', currency: 'EUR' },
  { slug: 'amsterdam', name: 'Amsterdam', currency: 'EUR' },
  { slug: 'tokyo', name: 'Tokyo', currency: 'JPY' },
]
const CITIES = process.env.CITIES
  ? ALL_CITIES.filter((c) => process.env.CITIES.split(',').includes(c.slug))
  : ALL_CITIES

// Amenities worth showing on a card, in display priority order.
const HIGHLIGHTS = [
  ['Pool', /\bpool\b/i],
  ['Hot tub', /hot tub/i],
  ['Beach access', /beach/i],
  ['Waterfront', /waterfront|lake access/i],
  ['Free parking', /free (street )?parking|free .*garage|free driveway/i],
  ['EV charger', /ev charger/i],
  ['Pets allowed', /pets allowed/i],
  ['Workspace', /dedicated workspace/i],
  ['Kitchen', /^kitchen$/i],
  ['Washer', /^washer/i],
  ['Air conditioning', /air conditioning|central air/i],
  ['Fireplace', /fireplace/i],
  ['Gym', /\bgym\b/i],
  ['Patio or balcony', /patio or balcony|balcony/i],
  ['Backyard', /backyard/i],
  ['Elevator', /^elevator$/i],
  ['Self check-in', /self check-in/i],
  ['Wifi', /wifi/i],
]

const STOPWORDS = new Set(
  'the a an and with to of in is for our you your this room apartment walk from bedroom it on at are has near'.split(' ')
)

const clean = (s = '') =>
  s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[^\p{L}\p{N}"'(]+/u, '') // leading bullets / dashes

const truncate = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n) > 0 ? s.lastIndexOf(' ', n) : n) + '…')

// e5-small-v2 is English-only; skip listings described in other languages.
function isEnglish(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) || []
  if (words.length < 8) return false
  const nonLatin = (text.match(/[^\x00-ɏ\s]/g) || []).length
  if (nonLatin > text.length * 0.1) return false
  return words.filter((w) => STOPWORDS.has(w)).length / words.length > 0.12
}

const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,]/g, '')))

function currencyOf(row, fallback) {
  const m = /"currency":\s*"([A-Z]{3})"/.exec(row.price_quote_raw || '')
  return m ? m[1] : fallback
}

async function latestUrls() {
  const html = await (await fetch('https://insideairbnb.com/get-the-data/')).text()
  const urls = {}
  for (const [url] of html.matchAll(/https:\/\/data\.insideairbnb\.com\/[^"'\s]+\/data\/listings\.csv\.gz/g)) {
    const parts = url.split('/')
    const slug = parts[parts.length - 4]
    const date = parts[parts.length - 3]
    if (!urls[slug] || urls[slug].date < date) urls[slug] = { url, date }
  }
  return urls
}

async function download(url, file) {
  if (existsSync(file)) return
  console.log(`  downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await writeFile(file, Buffer.from(await res.arrayBuffer()))
}

async function readRows(file) {
  const rows = []
  const parser = createReadStream(file).pipe(createGunzip()).pipe(parse({ columns: true, relax_quotes: true }))
  for await (const row of parser) rows.push(row)
  return rows
}

function toListing(row, cityIndex, city) {
  const amenities = JSON.parse(row.amenities || '[]')
  const description = clean(row.description)
  const highlights = HIGHLIGHTS.filter(([, re]) => amenities.some((a) => re.test(a))).map(([label]) => label)
  return {
    listing: {
      id: row.id,
      city: cityIndex,
      name: clean(row.name),
      hood: row.neighbourhood_cleansed || '',
      roomType: row.room_type,
      propertyType: row.property_type,
      guests: num(row.accommodates),
      bedrooms: num(row.bedrooms),
      beds: num(row.beds),
      baths: row.bathrooms_text || '',
      price: num(row.price),
      currency: currencyOf(row, city.currency),
      rating: num(row.review_scores_rating),
      reviews: num(row.number_of_reviews),
      superhost: row.host_is_superhost === 't',
      image: row.picture_url,
      description: truncate(description, 260),
      amenities: highlights,
    },
    // What gets embedded: everything a traveler might describe in a query.
    text:
      `${clean(row.name)}. ${row.room_type} (${row.property_type}) in ${row.neighbourhood_cleansed}, ` +
      `${city.name}. ` +
      `Sleeps ${row.accommodates}; ${row.bedrooms || 0} bedrooms, ${row.bathrooms_text}. ` +
      `${truncate(description, 700)} ${truncate(clean(row.neighborhood_overview), 300)} ` +
      `Amenities: ${amenities.slice(0, 60).join(', ')}.`,
  }
}

async function main() {
  mkdirSync(CACHE, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  const urls = await latestUrls()

  const cities = []
  const listings = []
  const texts = []
  for (const [cityIndex, city] of CITIES.entries()) {
    const src = urls[city.slug]
    if (!src) throw new Error(`No Inside Airbnb data found for ${city.slug}`)
    console.log(`${city.name} (${src.date})`)
    const file = join(CACHE, `${city.slug}-${src.date}.csv.gz`)
    await download(src.url, file)
    const rows = (await readRows(file)).filter(
      (r) =>
        num(r.price) > 0 &&
        num(r.review_scores_rating) != null &&
        num(r.number_of_reviews_ltm) >= 3 &&
        num(r.availability_365) > 0 &&
        r.picture_url &&
        isEnglish(clean(r.description))
    )
    // Favor listings that are actively booked, then well rated.
    rows.sort(
      (a, b) =>
        num(b.number_of_reviews_ltm) - num(a.number_of_reviews_ltm) ||
        num(b.review_scores_rating) - num(a.review_scores_rating)
    )
    const kept = rows.slice(0, PER_CITY)
    for (const row of kept) {
      const { listing, text } = toListing(row, cityIndex, city)
      listings.push(listing)
      texts.push(`passage: ${text}`)
    }
    cities.push({ slug: city.slug, name: city.name, currency: city.currency, date: src.date, count: kept.length })
    console.log(`  kept ${kept.length} of ${rows.length} eligible`)
  }

  console.log(`Embedding ${texts.length} listings with ${MODEL_ID}…`)
  const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
  const out = new Int8Array(texts.length * DIM)
  const BATCH = 32
  for (let i = 0; i < texts.length; i += BATCH) {
    const emb = (await extractor(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true })).tolist()
    emb.forEach((vec, j) => {
      // Normalized components are within [-1, 1]; scale to int8 and keep the
      // same scale for every row so dot products stay comparable.
      for (let k = 0; k < DIM; k++) out[(i + j) * DIM + k] = Math.max(-127, Math.min(127, Math.round(vec[k] * 127)))
    })
    if ((i / BATCH) % 20 === 0) console.log(`  ${Math.min(i + BATCH, texts.length)}/${texts.length}`)
  }

  writeFileSync(join(OUT, 'embeddings.bin'), out)
  writeFileSync(
    join(OUT, 'listings.json'),
    JSON.stringify({ model: MODEL_ID, dim: DIM, generated: new Date().toISOString().slice(0, 10), cities, listings })
  )
  console.log(`Wrote ${listings.length} listings to data/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
