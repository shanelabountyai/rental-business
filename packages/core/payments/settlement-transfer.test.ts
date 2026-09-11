import { describe, expect, it } from 'vitest'
import type { BusinessDate } from '../scheduling/local-time.ts'
import { settlementReportBlocks, validateSettlementTransfer } from './settlement-transfer.ts'

const day = (value: string) => value as BusinessDate
const TODAY = day('2026-04-10')
const valid = {
  from: day('2026-03-01'),
  to: day('2026-03-31'),
  grossCents: 150_000,
  amountDollars: '1455.25',
  transferredOn: '2026-04-04',
  reference: 'TRF-88213',
}

function fields(input: Partial<typeof valid>, today = TODAY) {
  return validateSettlementTransfer({ ...valid, ...input }, today).violations.map((v) => v.field)
}

describe('recording a transfer out of the shared account', () => {
  it('accepts a transfer short of what was owed, which is the ordinary case once fees come off', () => {
    expect(validateSettlementTransfer(valid, TODAY)).toEqual({ violations: [], transferredCents: 145_525 })
  })

  it('reads an amount typed with thousands separators', () => {
    expect(validateSettlementTransfer({ ...valid, amountDollars: '1,455.25' }, TODAY).transferredCents).toBe(
      145_525,
    )
  })

  it('refuses a range that has not ended, because money can still settle into it', () => {
    expect(fields({ to: day('2026-04-10'), transferredOn: '2026-04-10' })).toEqual(['window'])
  })

  it('refuses a range in which nothing is owed', () => {
    expect(fields({ grossCents: 0 })).toContain('window')
    expect(fields({ grossCents: -1_500 })).toContain('window')
  })

  it('refuses more than the entity is owed, and an amount that is not money', () => {
    expect(fields({ amountDollars: '1500.01' })).toEqual(['amountDollars'])
    expect(fields({ amountDollars: '1500.00' })).toEqual([])
    for (const amountDollars of ['', '0', '0.00', 'abc', '12.345', '-5']) {
      expect(fields({ amountDollars })).toEqual(['amountDollars'])
    }
  })

  it('refuses a transfer dated before the range ended or in the future, and allows its last day', () => {
    expect(fields({ transferredOn: '2026-03-30' })).toEqual(['transferredOn'])
    expect(fields({ transferredOn: '2026-04-11' })).toEqual(['transferredOn'])
    expect(fields({ transferredOn: '4 Apr 2026' })).toEqual(['transferredOn'])
    expect(fields({ transferredOn: '2026-03-31' })).toEqual([])
  })

  it('requires the reference that matches it to a bank statement', () => {
    expect(fields({ reference: '   ' })).toEqual(['reference'])
  })
})

describe('the archived settlement report', () => {
  const facts = {
    entityName: 'Maple Holdings LLC',
    from: day('2026-03-01'),
    to: day('2026-03-31'),
    settledCents: 300_000,
    reversedCents: 150_000,
    grossCents: 150_000,
    transferredCents: 145_525,
    transferredOn: day('2026-04-04'),
    reference: 'TRF-88213',
    properties: [
      {
        name: 'A property name long enough to be cut at the column edge on the page',
        settledCents: 300_000,
        reversedCents: 150_000,
        netCents: 150_000,
      },
    ],
    payments: [
      {
        settledOn: day('2026-03-05'),
        property: '4417 Magnolia Boulevard North Unit B',
        payer: 'Alexandria Montgomery-Whitfield',
        amountCents: 150_000,
        reversedOn: day('2026-03-20'),
      },
      {
        settledOn: day('2026-03-06'),
        property: '12 Oak',
        payer: 'Sam Lee',
        amountCents: 150_000,
        reversedOn: null,
      },
    ],
    recordedBy: 'Dana Owner',
    generatedAt: '10 Apr 2026, 09:12 UTC',
  }

  it('fits every table row inside the page, however long the names', () => {
    // 86 is MONO_LINE_CHARS in apps/web/lib/pdf/render.ts, which core cannot
    // import; statement-document.test.ts pins the same number the same way.
    for (const block of settlementReportBlocks(facts).filter((b) => b.kind === 'mono')) {
      for (const line of block.text.split('\n')) expect(line.length).toBeLessThanOrEqual(86)
    }
  })

  it('states what was owed, what moved and what was left, and prints no raw calendar day', () => {
    const text = settlementReportBlocks(facts)
      .map((b) => b.text)
      .join('\n')
    expect(text).toContain('Owed to the entity: $1,500.00 ($3,000.00 settled, less $1,500.00 returned)')
    expect(text).toContain('Transferred: $1,455.25 on 4 Apr 2026, reference TRF-88213')
    expect(text).toContain('Left in the shared account: $44.75')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('says nothing was left when the whole amount moved', () => {
    const text = settlementReportBlocks({ ...facts, transferredCents: 150_000 })
      .map((b) => b.text)
      .join('\n')
    expect(text).not.toContain('Left in the shared account')
  })
})
