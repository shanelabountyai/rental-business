import { describe, expect, it } from 'vitest'
import { buildFeed, buildFeedEntry, isSyndicationNetwork } from './feed.ts'

function baseListing() {
  return {
    id: 'listing_1',
    headline: null,
    description: 'A lovely home.',
    rentCents: 150_000,
    depositCents: 150_000,
    availableOn: '2026-09-01',
    requirements: null,
    petsAllowed: false,
    petPolicyText: null,
    addressLine1: '5 Main St',
    city: 'Houston',
    state: 'TX',
    postalCode: '77002',
    bedrooms: 3,
    bathrooms: 2,
    squareFeet: 1200,
    photoUrls: ['/listings/listing_1/photos/doc_1'],
  }
}

describe('isSyndicationNetwork', () => {
  it('recognises a real network and rejects an invented one', () => {
    expect(isSyndicationNetwork('ZILLOW')).toBe(true)
    expect(isSyndicationNetwork('CRAIGSLIST')).toBe(false)
  })
})

describe('buildFeedEntry', () => {
  it('falls back to the address when there is no headline', () => {
    const entry = buildFeedEntry(baseListing(), 'ZILLOW')
    expect(entry.headline).toBe('5 Main St, Houston')
  })

  it('uses the stated headline when there is one', () => {
    const entry = buildFeedEntry({ ...baseListing(), headline: 'Charming bungalow' }, 'ZUMPER')
    expect(entry.headline).toBe('Charming bungalow')
  })

  it('gives every network its OWN tracked path - the whole attribution mechanism', () => {
    const zillow = buildFeedEntry(baseListing(), 'ZILLOW')
    const zumper = buildFeedEntry(baseListing(), 'ZUMPER')
    expect(zillow.trackedPath).toBe('/listings/listing_1?src=ZILLOW')
    expect(zumper.trackedPath).toBe('/listings/listing_1?src=ZUMPER')
    expect(zillow.trackedPath).not.toBe(zumper.trackedPath)
  })

  it('carries the address, money and physical facts through unchanged', () => {
    const entry = buildFeedEntry(baseListing(), 'APARTMENTS_COM')
    expect(entry.rentCents).toBe(150_000)
    expect(entry.address).toEqual({
      line1: '5 Main St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
    })
    expect(entry.bedrooms).toBe(3)
    expect(entry.photoUrls).toEqual(['/listings/listing_1/photos/doc_1'])
  })
})

describe('buildFeed', () => {
  it('builds one entry per requested network, none extra', () => {
    const entries = buildFeed(baseListing(), ['ZILLOW', 'ZUMPER'])
    expect(entries.map((e) => e.network)).toEqual(['ZILLOW', 'ZUMPER'])
  })

  it('is empty for an empty network list', () => {
    expect(buildFeed(baseListing(), [])).toEqual([])
  })
})
