import { describe, expect, it } from 'vitest'
import type { ExportLine } from './export.ts'
import { type TaxPacketDocumentFacts, taxPacketBlocks } from './packet-document.ts'

// The archived packet's own page (RPT-07, R-081d).
//
// The arithmetic is `packet.test.ts`'s; what is asserted here is what the
// artifact SAYS - because a packet handed to a preparer is read without anyone
// to ask, so every caveat that lives on the screen has to survive onto the
// page, and D-50's "name what you could not attach" has to be visible in the
// text rather than merely intended.

function facts(overrides: Partial<TaxPacketDocumentFacts> = {}): TaxPacketDocumentFacts {
  return {
    legalEntityName: 'Cedar Holdings LLC',
    year: 2026,
    basis: 'cash',
    scheduleE: [
      {
        propertyId: 'prop_a',
        propertyName: '12 Cedar Row',
        totals: [{ key: 'RENTS_RECEIVED', line: 3, label: 'Rents received', amountCents: 1_740_000 }],
        incomeCents: 1_740_000,
        expenseCents: 0,
        netCents: 1_740_000,
      },
    ],
    capex: [],
    depositLiability: { byProperty: [], totalCents: 0 },
    vendors: [],
    exceptions: [],
    exceptionCents: 0,
    exhibits: [],
    generatedAt: '21 August 2026 at 14:05',
    generatedBy: 'Sam Owner',
    timezone: 'UTC',
    ...overrides,
  }
}

const text = (blocks: ReturnType<typeof taxPacketBlocks>) => blocks.map((b) => b.text).join('\n')

describe('taxPacketBlocks', () => {
  it('names the basis on the artifact', () => {
    // The SAME work order books in two different tax years depending on this
    // (D-71), so a packet that did not say which basis produced it is one
    // nobody can reconcile against next year's.
    expect(text(taxPacketBlocks(facts()))).toContain('Cash — when money moved')
    expect(text(taxPacketBlocks(facts({ basis: 'accrual' })))).toContain(
      'Accrual — when it was billed',
    )
  })

  it('carries the unfillable Schedule E lines rather than leaving them blank', () => {
    // R-078's rule, on the artifact: a missing expense line reads as a zero,
    // and a zero overstates income.
    const out = text(taxPacketBlocks(facts()))
    expect(out).toContain('cannot fill at all')
    expect(out).toContain('absent rather than zero')
  })

  it('says the deposit figure is a balance on a date, not a period flow', () => {
    const out = text(
      taxPacketBlocks(
        facts({
          depositLiability: {
            byProperty: [
              { propertyId: 'prop_a', propertyName: '12 Cedar Row', depositCount: 2, liabilityCents: 290_000 },
            ],
            totalCents: 290_000,
          },
        }),
      ),
    )
    expect(out).toContain('Security deposit liability at 31 December 2026')
    expect(out).toContain('a balance on a date, not deposits received during the year')
    expect(out).toContain('$2,900.00')
  })

  it('prints the reportable 1099 figure and the total paid, never only one', () => {
    // $400 by card + $300 by cheque is a $300 1099-NEC. Both numbers appear,
    // because a preparer who saw only the $700 would file the wrong form and
    // one who saw only the $300 could not tell why.
    const out = text(
      taxPacketBlocks(
        facts({
          vendors: [
            {
              vendorId: 'ven_1',
              vendorName: 'Mixed Plumbing',
              w9OnFile: false,
              totalPaidCents: 70_000,
              reportableCents: 30_000,
              cardCents: 40_000,
              requiresForm: false,
              missingW9: false,
            },
          ],
        }),
      ),
    )
    expect(out).toContain('$300.00')
    expect(out).toContain('$700.00 paid, $400.00 by card')
    expect(out).toContain('under the threshold')
  })

  it('flags a missing W-9 above the threshold', () => {
    const out = text(
      taxPacketBlocks(
        facts({
          vendors: [
            {
              vendorId: 'ven_2',
              vendorName: 'Roofing Co',
              w9OnFile: false,
              totalPaidCents: 80_000,
              reportableCents: 80_000,
              cardCents: 0,
              requiresForm: true,
              missingW9: true,
            },
          ],
        }),
      ),
    )
    expect(out).toContain('NO W-9 ON FILE')
    expect(out).toContain('1 vendor above are over the threshold with no W-9 on file.')
  })

  it('carries unmapped rows onto the artifact with their reason', () => {
    const exception: ExportLine = {
      section: 'EXCEPTION',
      bookedOn: null,
      propertyId: 'prop_a',
      propertyName: '12 Cedar Row',
      scheduleELine: null,
      scheduleELabel: 'Unmapped',
      quickBooksAccount: '',
      description: 'Water — landlord share',
      amountCents: 8_400,
      sourceKind: 'UtilityBill',
      sourceId: 'ub_1',
      reason: 'UtilityBill records no payment date, so it has no cash-basis year.',
    }
    const out = text(taxPacketBlocks(facts({ exceptions: [exception], exceptionCents: 8_400 })))
    expect(out).toContain('Unmapped — 1 row, $84.00')
    expect(out).toContain('no payment date')
  })

  it('names a 1098 it could not attach, and says so in a sentence', () => {
    // D-50. The index alone is not enough - a reader scanning the list has to
    // be told, in prose, that something is missing and can be produced.
    const out = text(
      taxPacketBlocks(
        facts({
          exhibits: [
            { label: 'First National — 12 Cedar Row', kind: 'Form 1098 (2026)', occurredOn: '4 Feb 2027', attached: true },
            { label: 'Second Bank — 9 Birch Lane', kind: 'Form 1098 (2026)', occurredOn: '4 Feb 2027', attached: false },
          ],
        }),
      ),
    )
    expect(out).toContain('[NOT ATTACHED]')
    expect(out).toContain('1 exhibit is listed above but could not be attached')
    expect(out).not.toContain('exhibits are listed above')
  })

  it('says nothing is attached rather than staying silent when there are no 1098s', () => {
    const out = text(taxPacketBlocks(facts()))
    expect(out).toContain('No Form 1098 was recorded for this entity and year')
    expect(out).not.toContain('could not be attached to this file')
  })

  it('carries the disclaimer and the provenance line', () => {
    const out = text(taxPacketBlocks(facts()))
    expect(out).toContain('bookkeeping, not tax advice')
    expect(out).toContain('Produced 21 August 2026 at 14:05 (UTC) by Sam Owner')
  })

  it('never lets a long property name push a money column out of alignment', () => {
    // The renderer draws mono blocks as given and clips at the right margin.
    // A packet whose numbers do not line up is the document nobody can read -
    // the same failure `STATEMENT_COLUMNS` exists to prevent.
    const blocks = taxPacketBlocks(
      facts({
        depositLiability: {
          byProperty: [
            {
              propertyId: 'prop_a',
              propertyName: 'The Extremely Long Property Name That Nobody Should Have Typed',
              depositCount: 1,
              liabilityCents: 145_000,
            },
          ],
          totalCents: 145_000,
        },
      }),
    )
    for (const block of blocks.filter((b) => b.kind === 'mono')) {
      // 46 + 2 gap + 14. Well inside the renderer's 84-character line.
      expect(block.text.length).toBeLessThanOrEqual(62)
    }
  })
})
