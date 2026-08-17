import { describe, expect, it } from 'vitest'
import { listingDisclosures, validateListing } from './index.ts'

function baseInput(overrides: Partial<Parameters<typeof validateListing>[0]> = {}) {
  return {
    unitId: 'unit_1',
    rentCents: 150_000,
    depositCents: 150_000,
    availableOn: new Date('2026-09-01'),
    petsAllowed: false,
    petPolicyText: null,
    ...overrides,
  }
}

describe('validateListing', () => {
  it('accepts a complete, consistent listing', () => {
    expect(validateListing(baseInput())).toEqual([])
  })

  it('accepts every optional field left blank', () => {
    expect(
      validateListing(
        baseInput({ depositCents: null, headline: null, description: null, requirements: null }),
      ),
    ).toEqual([])
  })

  it('rejects a missing unit', () => {
    expect(validateListing(baseInput({ unitId: '' }))).toContainEqual(
      expect.objectContaining({ field: 'unitId' }),
    )
  })

  it('rejects a zero or negative rent', () => {
    expect(validateListing(baseInput({ rentCents: 0 }))).toContainEqual(
      expect.objectContaining({ field: 'rentCents' }),
    )
    expect(validateListing(baseInput({ rentCents: -100 }))).toContainEqual(
      expect.objectContaining({ field: 'rentCents' }),
    )
  })

  it('rejects a negative deposit but allows zero', () => {
    expect(validateListing(baseInput({ depositCents: -1 }))).toContainEqual(
      expect.objectContaining({ field: 'depositCents' }),
    )
    expect(validateListing(baseInput({ depositCents: 0 }))).toEqual([])
  })

  it('rejects a missing or unparseable available date', () => {
    expect(validateListing(baseInput({ availableOn: null }))).toContainEqual(
      expect.objectContaining({ field: 'availableOn' }),
    )
    expect(
      validateListing(baseInput({ availableOn: new Date('not-a-date') })),
    ).toContainEqual(expect.objectContaining({ field: 'availableOn' }))
  })

  it('requires policy text when pets are allowed, but not when they are refused', () => {
    expect(
      validateListing(baseInput({ petsAllowed: true, petPolicyText: null })),
    ).toContainEqual(expect.objectContaining({ field: 'petPolicyText' }))
    expect(
      validateListing(baseInput({ petsAllowed: true, petPolicyText: 'Cats only, $300 deposit.' })),
    ).toEqual([])
    // "No pets" needs no further explanation.
    expect(validateListing(baseInput({ petsAllowed: false, petPolicyText: null }))).toEqual([])
  })
})

describe('listingDisclosures', () => {
  it('states the configured cap when one exists', () => {
    const disclosures = listingDisclosures({
      state: 'TX',
      depositMaxBps: null,
      applicationFeeCapCents: 5000,
      sourceOfIncomeProtected: null,
    })
    const fee = disclosures.find((d) => d.label === 'Application fee')
    expect(fee?.text).toContain('$50.00')
  })

  it('names the gap honestly when a cap is not on file, rather than staying silent', () => {
    const disclosures = listingDisclosures({
      state: 'TX',
      depositMaxBps: null,
      applicationFeeCapCents: null,
      sourceOfIncomeProtected: null,
    })
    expect(disclosures).toHaveLength(3)
    for (const d of disclosures) {
      expect(d.text.length).toBeGreaterThan(0)
    }
  })

  it('distinguishes protected, not protected, and unreviewed source of income', () => {
    const protectedCase = listingDisclosures({
      state: 'NY',
      depositMaxBps: null,
      applicationFeeCapCents: null,
      sourceOfIncomeProtected: true,
    }).find((d) => d.label === 'Source of income')
    expect(protectedCase?.text).toContain('protected class')

    const notProtected = listingDisclosures({
      state: 'TX',
      depositMaxBps: null,
      applicationFeeCapCents: null,
      sourceOfIncomeProtected: false,
    }).find((d) => d.label === 'Source of income')
    expect(notProtected?.text).toContain('does not require')

    const unreviewed = listingDisclosures({
      state: 'TX',
      depositMaxBps: null,
      applicationFeeCapCents: null,
      sourceOfIncomeProtected: null,
    }).find((d) => d.label === 'Source of income')
    expect(unreviewed?.text).toContain('not been reviewed')
  })
})
