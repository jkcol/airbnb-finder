// Pulls hard constraints (city, price, group size, bedrooms, room type) out of
// a free-text query. Semantic similarity can't enforce "under $200", so these
// become filters; the full query text is still embedded for ranking.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2,
}
const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join('|')})`
const toNum = (s) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s)

// Extra names people use for a city, keyed by the city's display name.
const CITY_ALIASES = {
  'New York': ['nyc', 'new york city', 'manhattan', 'brooklyn', 'queens'],
  'Los Angeles': ['la', 'l\\.a\\.', 'hollywood', 'santa monica', 'venice beach'],
  'San Francisco': ['sf', 'san fran', 'bay area'],
  London: ['londres'],
  Rome: ['roma'],
  Lisbon: ['lisboa'],
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function findCity(text, cityNames) {
  for (const name of cityNames) {
    const aliases = [escape(name.toLowerCase()), ...(CITY_ALIASES[name] || [])]
    if (new RegExp(`\\b(${aliases.join('|')})\\b`, 'i').test(text)) return name
  }
  return null
}

// A number is a price if it has a currency sign or a per-night unit, or is big
// enough and not followed by a distance/time unit ("under 10 minutes").
const MONEY = '([$£€¥])?\\s*(\\d[\\d,]*)(?!\\d)(\\s*(?:/|a|per)\\s*night|\\s*(?:dollars|usd|euros?|pounds|gbp))?(?!\\s*(?:min|minutes?|mins|km|miles?|mi|blocks?|m|hours?|hrs?|people|guests|bed|br|%))'
const money = (sign, n, unit) => {
  const v = Number(n.replace(/,/g, ''))
  return sign || unit || v >= 30 ? v : null
}

export function parseQuery(text, cityNames = []) {
  const t = ` ${text.toLowerCase()} `
  const filters = {}

  const city = findCity(t, cityNames)
  if (city) filters.city = city

  let m
  if ((m = t.match(new RegExp(`${MONEY}\\s*(?:-|to)\\s*${MONEY}`))) && (m[1] || m[3] || m[4] || m[6])) {
    filters.minPrice = money('$', m[2])
    filters.maxPrice = money('$', m[5])
  } else if ((m = t.match(new RegExp(`(?:under|below|less than|cheaper than|max(?:imum)?|up to|at most|<)\\s*${MONEY}`)))) {
    const v = money(m[1], m[2], m[3])
    if (v) filters.maxPrice = v
  }
  // "over"/"above" need an explicit currency sign so "over 4 guests" isn't a price.
  if (!filters.minPrice && (m = t.match(/(?:over|above|more than|at least|min(?:imum)?)\s*[$£€¥]\s*(\d[\d,]*)/))) {
    filters.minPrice = money('$', m[1])
  }

  if ((m = t.match(new RegExp(`\\b(?:for|sleeps|fits|sleeping|group of|family of|party of)\\s+(?:a\\s+)?${NUM}\\b(?!\\s*(?:bed|br|bd|night|week|day|\\$))`)))
    || (m = t.match(new RegExp(`\\b${NUM}\\s+(?:people|guests|persons|adults|travell?ers|friends|of us)\\b`)))) {
    const n = toNum(m[1])
    if (n > 0 && n <= 16) filters.guests = n
  } else if (/\b(?:couple|romantic|honeymoon)\b/.test(t)) {
    filters.guests = 2
  }

  if ((m = t.match(new RegExp(`\\b${NUM}\\s*-?\\s*(?:bedrooms?|br|bdr?m?s?)\\b`)))) {
    const n = toNum(m[1])
    if (n > 0 && n <= 10) filters.bedrooms = n
  }

  if (/\bprivate room\b/.test(t)) filters.roomType = 'Private room'
  else if (/\bshared room\b|\bhostel\b/.test(t)) filters.roomType = 'Shared room'
  else if (/\b(?:entire|whole)\s+(?:place|home|house|apartment|apt|flat|unit|condo|loft)\b/.test(t)) {
    filters.roomType = 'Entire home/apt'
  }

  return filters
}
