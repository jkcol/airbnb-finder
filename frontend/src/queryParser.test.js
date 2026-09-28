import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery } from './queryParser.js'

const CITIES = ['New York', 'Los Angeles', 'San Francisco', 'London', 'Paris', 'Rome']
const p = (q) => parseQuery(q, CITIES)

test('cities and aliases', () => {
  assert.equal(p('loft in NYC').city, 'New York')
  assert.equal(p('brooklyn brownstone').city, 'New York')
  assert.equal(p('beach house in LA').city, 'Los Angeles')
  assert.equal(p('flat near the Eiffel tower in paris').city, 'Paris')
  assert.equal(p('cozy cabin in the woods').city, undefined)
})

test('prices', () => {
  assert.deepEqual(p('studio under $150'), { maxPrice: 150 })
  assert.deepEqual(p('below 200 a night'), { maxPrice: 200 })
  assert.deepEqual(p('less than £90'), { maxPrice: 90 })
  assert.deepEqual(p('between $100 - $250'), { minPrice: 100, maxPrice: 250 })
  assert.deepEqual(p('150 to 300 per night'), { minPrice: 150, maxPrice: 300 })
  assert.deepEqual(p('luxury villa over $500'), { minPrice: 500 })
  assert.deepEqual(p('up to 1,200 dollars'), { maxPrice: 1200 })
})

test('numbers that are not prices', () => {
  assert.deepEqual(p('under 10 minutes to the beach'), {})
  assert.deepEqual(p('less than 5 km from the center'), {})
  assert.deepEqual(p('under 3 blocks from the subway'), {})
})

test('group size', () => {
  assert.equal(p('house for 6 people').guests, 6)
  assert.equal(p('sleeps eight').guests, 8)
  assert.equal(p('for a family of five').guests, 5)
  assert.equal(p('4 friends weekend').guests, 4)
  assert.equal(p('romantic getaway').guests, 2)
  assert.equal(p('for 3 nights').guests, undefined)
  assert.equal(p('for 2 bedrooms').guests, undefined)
})

test('bedrooms and room type', () => {
  assert.equal(p('3 bedroom house').bedrooms, 3)
  assert.equal(p('2br apartment').bedrooms, 2)
  assert.equal(p('two-bedroom flat').bedrooms, 2)
  assert.equal(p('private room in shared house').roomType, 'Private room')
  assert.equal(p('entire place with garden').roomType, 'Entire home/apt')
})

test('combined', () => {
  assert.deepEqual(p('quiet 2 bedroom apartment in London for 4 people under £250 with a garden'), {
    city: 'London', maxPrice: 250, guests: 4, bedrooms: 2,
  })
})
