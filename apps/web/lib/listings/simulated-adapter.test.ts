import type { FeedEntry } from '@rental/core/listings'
import { describe, expect, it } from 'vitest'
import { SyndicationError } from './adapter.ts'
import { SimulatedSyndicationAdapter } from './simulated-adapter.ts'

// The simulated syndication provider (D-7, R-057). No database - this is
// the adapter's own contract, exercised the way
// billing/simulated-adapter.ts's sibling tests exercise Stripe's simulator.

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    network: 'ZILLOW',
    externalRef: 'listing:l1',
    trackedPath: '/listings/l1?src=ZILLOW',
    headline: 'A house',
    description: '',
    rentCents: 150_000,
    depositCents: null,
    availableOn: '2026-09-01',
    requirements: null,
    petsAllowed: false,
    petPolicyText: null,
    address: { line1: '5 Main St', city: 'Houston', state: 'TX', postalCode: '77002' },
    bedrooms: null,
    bathrooms: null,
    squareFeet: null,
    photoUrls: [],
    ...overrides,
  }
}

describe('SimulatedSyndicationAdapter', () => {
  it('says what it is', () => {
    expect(new SimulatedSyndicationAdapter().name).toBe('simulated')
  })

  it('mints a realistic-shaped id per network on a successful list()', async () => {
    const adapter = new SimulatedSyndicationAdapter()
    const result = await adapter.list(entry())
    expect(result.externalId).toMatch(/^zillow_[a-f0-9]{24}$/)
  })

  it('mints a DIFFERENT id each call - never deterministic from the input', async () => {
    const adapter = new SimulatedSyndicationAdapter()
    const first = await adapter.list(entry())
    const second = await adapter.list(entry())
    expect(first.externalId).not.toBe(second.externalId)
  })

  it('delist() resolves without throwing when nothing is injected', async () => {
    const adapter = new SimulatedSyndicationAdapter()
    await expect(adapter.delist('ZILLOW', 'zillow_abc')).resolves.toBeUndefined()
  })

  it('throws a SyndicationError carrying the injected fault code on list()', async () => {
    const adapter = new SimulatedSyndicationAdapter({ fault: () => 'timeout' })
    await expect(adapter.list(entry())).rejects.toMatchObject({
      name: 'SyndicationError',
      code: 'timeout',
    })
  })

  it('throws on delist() too, and the fault fn sees which op it is', async () => {
    const seenOps: string[] = []
    const adapter = new SimulatedSyndicationAdapter({
      fault: (_network, op) => {
        seenOps.push(op)
        return op === 'delist' ? 'partial_failure' : null
      },
    })
    await expect(adapter.list(entry())).resolves.toBeTruthy()
    await expect(adapter.delist('ZILLOW', 'zillow_abc')).rejects.toBeInstanceOf(SyndicationError)
    expect(seenOps).toEqual(['list', 'delist'])
  })

  it('only faults the network it is told to - a partial failure is really partial', async () => {
    const adapter = new SimulatedSyndicationAdapter({
      fault: (network) => (network === 'ZUMPER' ? 'malformed_response' : null),
    })
    await expect(adapter.list(entry({ network: 'ZILLOW' }))).resolves.toBeTruthy()
    await expect(adapter.list(entry({ network: 'ZUMPER' }))).rejects.toBeInstanceOf(SyndicationError)
  })
})
