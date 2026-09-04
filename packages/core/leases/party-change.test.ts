import { describe, expect, it } from 'vitest'
import {
  DEPOSIT_STAYS_WITH_UNIT,
  GUARANTEE_RELEASE_IS_PROSPECTIVE,
  OTHERWISE_UNCHANGED,
  RELEASE_IS_PROSPECTIVE,
  amendmentDocumentBlocks,
  assessPartyChange,
  type PartyChangeInput,
} from './party-change.ts'

// RISK-10 (R-090). The two rules worth a test each are the two that refuse:
// a tenancy cannot be emptied by a "roommate change", and a replacement
// nobody screened cannot be added. Everything else in this module is either
// a date comparison or prose.

const base: PartyChangeInput = {
  leaseStatus: 'ACTIVE',
  currentTenantIds: ['t-alice', 't-bob'],
  outgoing: [],
  incoming: [],
  effectiveOn: '2026-09-01',
  leaseStartsOn: '2026-01-01',
  leaseEndsOn: '2026-12-31',
  reason: 'Bob is moving out; Cara replaces him.',
}

const screened = {
  tenantId: 't-cara',
  name: 'Cara Diaz',
  applicantId: 'app-cara',
  screeningDecision: 'APPROVED' as const,
  monthlyIncomeCents: 600_000,
}

function fields(input: PartyChangeInput) {
  return assessPartyChange(input, null).violations.map((v) => v.field)
}

describe('assessPartyChange', () => {
  it('accepts a straight swap of one roommate for a screened replacement', () => {
    const result = assessPartyChange(
      { ...base, outgoing: [{ tenantId: 't-bob', name: 'Bob Ray' }], incoming: [screened] },
      null,
    )
    expect(result.violations).toEqual([])
    expect(result.remainingTenantIds).toEqual(['t-alice', 't-cara'])
  })

  it('refuses to empty a running tenancy', () => {
    const result = assessPartyChange(
      {
        ...base,
        outgoing: [
          { tenantId: 't-alice', name: 'Alice Nu' },
          { tenantId: 't-bob', name: 'Bob Ray' },
        ],
      },
      null,
    )
    expect(result.remainingTenantIds).toEqual([])
    expect(result.violations.map((v) => v.message).join(' ')).toContain('nobody on the tenancy')
  })

  // A whole-tenancy assignment is the SAME operation, and must be allowed:
  // everybody leaves and an assignee takes over on the same amendment. It is
  // only the empty result that is refused, never the fact that every
  // original party is going.
  it('allows a whole-tenancy assignment', () => {
    const result = assessPartyChange(
      {
        ...base,
        outgoing: [
          { tenantId: 't-alice', name: 'Alice Nu' },
          { tenantId: 't-bob', name: 'Bob Ray' },
        ],
        incoming: [screened],
      },
      null,
    )
    expect(result.violations).toEqual([])
    expect(result.remainingTenantIds).toEqual(['t-cara'])
  })

  it('refuses a replacement with no application, no decision, or a decline', () => {
    expect(fields({ ...base, incoming: [{ tenantId: 't-cara', name: 'Cara Diaz' }] })).toEqual([
      'incoming',
    ])
    expect(
      fields({
        ...base,
        incoming: [{ ...screened, screeningDecision: null }],
      }),
    ).toEqual(['incoming'])
    expect(
      fields({
        ...base,
        incoming: [{ ...screened, screeningDecision: 'DECLINED' }],
      }),
    ).toEqual(['incoming'])
  })

  // CONDITIONAL is an approval with strings attached (a co-signer, a larger
  // deposit) - a decision a person made, not an absence of one. It passes
  // here for the same reason it passes anywhere else in this product.
  it('accepts a conditional approval', () => {
    expect(fields({ ...base, incoming: [{ ...screened, screeningDecision: 'CONDITIONAL' }] })).toEqual(
      [],
    )
  })

  it('refuses a change on a lease that is not running, and one that moves nobody', () => {
    expect(fields({ ...base, leaseStatus: 'ENDED', incoming: [screened] })).toEqual(['lease'])
    expect(fields(base)).toEqual(['parties'])
  })

  // R-165: a guarantor release moves nobody in `outgoing`/`incoming` at all -
  // it is the one case the "at least one" check must not mistake for an
  // empty form.
  it('accepts a guarantor-only release with no tenant moving', () => {
    const result = assessPartyChange(
      { ...base, outgoingGuarantors: [{ id: 'g-pat', name: 'Pat Nu' }] },
      null,
    )
    expect(result.violations).toEqual([])
    expect(result.remainingTenantIds).toEqual(['t-alice', 't-bob'])
  })

  it('refuses an effective date outside the term', () => {
    expect(
      fields({ ...base, effectiveOn: '2025-12-31', incoming: [screened] }),
    ).toEqual(['effectiveOn'])
    expect(fields({ ...base, effectiveOn: '2027-02-01', incoming: [screened] })).toEqual([
      'effectiveOn',
    ])
    // A month-to-month tenancy has no end, so nothing to be after.
    expect(
      fields({ ...base, leaseEndsOn: null, effectiveOn: '2027-02-01', incoming: [screened] }),
    ).toEqual([])
  })

  it('warns, without refusing, when the replacement does not carry the rent alone', () => {
    const criteria = { incomeToRentMultiplierX100: 300, rentCents: 250_000 }
    const result = assessPartyChange(
      {
        ...base,
        outgoing: [{ tenantId: 't-bob', name: 'Bob Ray' }],
        incoming: [{ ...screened, monthlyIncomeCents: 400_000 }],
      },
      criteria,
    )
    expect(result.violations).toEqual([])
    expect(result.warnings.map((w) => w.key)).toEqual(['household_income'])
  })

  it('does not warn when the replacement clears the multiplier on their own', () => {
    const criteria = { incomeToRentMultiplierX100: 300, rentCents: 150_000 }
    const result = assessPartyChange(
      {
        ...base,
        outgoing: [{ tenantId: 't-bob', name: 'Bob Ray' }],
        incoming: [{ ...screened, monthlyIncomeCents: 450_000 }],
      },
      criteria,
    )
    expect(result.warnings).toEqual([])
  })
})

describe('amendmentDocumentBlocks', () => {
  const facts = {
    propertyName: 'Cedar Row',
    propertyAddress: '18 Cedar Row',
    unitName: 'Unit B',
    entityName: 'Cedar Row Rentals LLC',
    effectiveOn: '2026-09-01',
    generatedOn: '2026-08-23',
    reason: 'Bob is moving out; Cara replaces him.',
    rentAmount: '$1,600.00',
    depositAmount: '$1,600.00',
    termStartsOn: '2026-01-01',
    termEndsOn: '2026-12-31',
    outgoingNames: ['Bob Ray'],
    incomingNames: ['Cara Diaz'],
    remainingNames: ['Alice Nu', 'Cara Diaz'],
    signers: [
      { order: 1, role: 'TENANT' as const, name: 'Alice Nu', signedAt: null, signedName: null },
      { order: 2, role: 'GUARANTOR' as const, name: 'Pat Nu', signedAt: null, signedName: null },
    ],
  }

  // The three standing clauses are the whole legal content of this document.
  // Asserting them by identity rather than by phrase means rewording one is
  // a deliberate edit to the constant, not something that slips past a test
  // matching on a substring that happens to survive.
  it('carries the deposit rule, the prospective release and the unchanged-terms clause', () => {
    const texts = amendmentDocumentBlocks(facts).map((b) => b.text)
    expect(texts).toContain(DEPOSIT_STAYS_WITH_UNIT)
    expect(texts).toContain(RELEASE_IS_PROSPECTIVE)
    expect(texts).toContain(OTHERWISE_UNCHANGED)
  })

  // Nobody is leaving, so a release clause would be a paragraph about a
  // person who does not exist - the sort of boilerplate that teaches readers
  // to skip the document.
  it('omits the release clause when nobody is leaving', () => {
    const texts = amendmentDocumentBlocks({ ...facts, outgoingNames: [] }).map((b) => b.text)
    expect(texts).not.toContain(RELEASE_IS_PROSPECTIVE)
    expect(texts).toContain(DEPOSIT_STAYS_WITH_UNIT)
  })

  // The amendment states the rent and the deposit as unchanged figures. If a
  // later edit ever made either of them settable here, this is the test that
  // has to be deleted first.
  it('prints the rent and deposit as unchanged', () => {
    const texts = amendmentDocumentBlocks(facts).map((b) => b.text)
    expect(texts).toContain('Rent (unchanged): $1,600.00')
    expect(texts).toContain('Security deposit held (unchanged): $1,600.00')
  })

  // R-165: a released guarantor gets their own clause and is never called an
  // "occupant" - the occupant release clause must not fire for them.
  it('prints a guarantor release under its own heading, not as an occupant', () => {
    const texts = amendmentDocumentBlocks({
      ...facts,
      outgoingNames: [],
      incomingNames: [],
      outgoingGuarantorNames: ['Pat Nu'],
    }).map((b) => b.text)
    expect(texts).toContain(GUARANTEE_RELEASE_IS_PROSPECTIVE)
    expect(texts).toContain('Pat Nu')
    expect(texts).not.toContain(RELEASE_IS_PROSPECTIVE)
  })

  it('omits the guarantor release clause when no guarantor is leaving', () => {
    const texts = amendmentDocumentBlocks(facts).map((b) => b.text)
    expect(texts).not.toContain(GUARANTEE_RELEASE_IS_PROSPECTIVE)
  })
})
