import { describe, expect, it } from 'vitest'
import { depositPacketBlocks, type DepositPacketFacts } from './deposit-packet.ts'

// R-218. The packet's value is the facts a hand-assembled one misses, so the
// assertions are on those sentences: the depreciation guidance, the
// unsupported flag, the tenant's missing signature, a late date - and that no
// raw `YYYY-MM-DD` reaches the page (D-153).

const facts: DepositPacketFacts = {
  propertyName: 'Riverside Court Duplex',
  addressLine1: '48 Riverside Ct',
  unitName: 'Unit A',
  tenantNames: ['Maria Alvarez'],
  moveOutOn: '2026-07-31',
  heldCents: 200_000,
  receivedOn: '2025-08-01',
  dispositionDueOn: '2026-08-30',
  dispositionSentOn: '2026-08-20',
  forwardingAddress: '12 Elm St, Austin TX',
  service: [{ methodLabel: 'Certified mail', servedOn: '2026-09-02' }],
  appliedCents: 96_000,
  refundedCents: 104_000,
  refundPaidOn: null,
  refundMethodLabel: null,
  refundReference: null,
  moveIn: { performedOn: '2025-08-01', tenantSignedOn: null },
  moveOut: { performedOn: '2026-08-01' },
  comparison: [
    {
      room: 'Kitchen',
      item: 'Counter',
      moveInCondition: 'GOOD',
      moveOutCondition: 'DAMAGED',
    },
    {
      room: 'Bedroom',
      item: 'Blinds',
      moveInCondition: 'GOOD',
      moveOutCondition: 'GOOD',
    },
  ],
  deductions: [
    {
      description: 'Carpet replacement',
      amountCents: 90_000,
      workOrderScope: null,
      inspectionItem: {
        room: 'Kitchen',
        item: 'Counter',
        moveInCondition: 'GOOD',
        moveOutCondition: 'DAMAGED',
      },
      evidenceFileCount: 0,
      estimatedAgeYears: 9,
      usefulLifeYears: 10,
    },
    {
      description: 'Missing blinds',
      amountCents: 6_000,
      workOrderScope: null,
      inspectionItem: null,
      evidenceFileCount: 0,
      estimatedAgeYears: null,
      usefulLifeYears: null,
    },
  ],
  exhibits: [
    {
      label: 'Disposition letter',
      kind: 'Notice',
      occurredOn: '20 Aug 2026',
      attached: false,
    },
  ],
  generatedAt: '17 Sept 2026, 10:00',
  generatedBy: 'Owner',
  timezone: 'America/Chicago',
}

const text = (f: DepositPacketFacts) =>
  depositPacketBlocks(f)
    .map((b) => b.text)
    .join('\n')

describe('depositPacketBlocks', () => {
  it('states the depreciation guidance applied to each deduction, and says so when none was', () => {
    const out = text(facts)
    expect(out).toContain('9 years old, of a 10-year useful life; age-based guidance is at most $90.00')
    expect(out).toContain('The amount claimed EXCEEDS that guidance.')
    expect(out).toContain('no age or useful life was recorded, so no age-based guidance was applied')
  })

  it('names an unsupported deduction and the evidence behind a supported one', () => {
    const out = text(facts)
    expect(out).toContain('Evidence: none linked — this deduction is unsupported.')
    expect(out).toContain('move-out item Kitchen — Counter (move-in Good, move-out Damaged)')
  })

  it('names the awkward facts: an unsigned move-in report, late service, an unpaid refund', () => {
    const out = text(facts)
    expect(out).toContain('not signed by the tenant')
    expect(out).toContain('Served: 2 Sept 2026 — Certified mail (after the disposition due date)')
    expect(out).not.toContain('Disposition letter written: 20 Aug 2026 (after')
    expect(out).toContain('Refund paid: not recorded as paid')
    expect(text({ ...facts, service: [] })).toContain('No service of the disposition letter is recorded.')
  })

  it('marks only the items whose condition changed', () => {
    const out = text(facts)
    expect(out).toMatch(/Kitchen — Counter\s+Good -> Damaged {2}\*/)
    expect(out).toMatch(/Bedroom — Blinds\s+Good -> Good$/m)
  })

  it('never prints a raw calendar day', () => {
    expect(text(facts)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
