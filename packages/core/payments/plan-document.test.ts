import { describe, expect, it } from 'vitest'
import {
  PLAN_NOT_A_WAIVER,
  PLAN_RENT_STILL_DUE,
  PLAN_SCHEDULE_WIDTH,
  paymentPlanDocumentBlocks,
} from './plan-document.ts'
import { PLAN_GRACE_DAYS } from './plan.ts'

// The repayment agreement's own text (R-203).

const FACTS = {
  propertyName: 'Magnolia House',
  propertyAddress: '310 Magnolia Dr',
  unitName: 'Unit A',
  entityName: 'Magnolia Holdings LLC',
  tenantNames: ['Jordan Ruiz', 'Cara Diaz'],
  arrearsCents: 90_000,
  agreedOn: '2026-09-12',
  generatedOn: '2026-09-12',
  note: 'Three payments; she starts the new job on the 14th.',
  instalments: [
    { sequence: 1, dueOn: '2026-10-01', amountCents: 30_000 },
    { sequence: 2, dueOn: '2026-11-01', amountCents: 30_000 },
    { sequence: 3, dueOn: '2026-12-01', amountCents: 30_000 },
  ],
  signers: [
    { order: 1, role: 'TENANT' as const, name: 'Jordan Ruiz', signedAt: null, signedName: null },
    { order: 2, role: 'TENANT' as const, name: 'Cara Diaz', signedAt: null, signedName: null },
  ],
}

describe('paymentPlanDocumentBlocks', () => {
  it('states the arrears, the schedule and the total', () => {
    const blocks = paymentPlanDocumentBlocks(FACTS)
    const text = blocks.map((b) => b.text).join('\n')
    expect(text).toContain('Arrears covered by this plan: $900.00')
    expect(text).toContain('1 of 3')
    expect(text).toContain('1 Oct 2026')
    expect(text).toContain('1 Dec 2026')
    // The total is computed from the instalments, never taken as a
    // parameter - a document whose rows and total could disagree is the one
    // thing a signed schedule must not be.
    const mono = blocks.filter((b) => b.kind === 'mono').map((b) => b.text)
    expect(mono.at(-1)).toContain('Total')
    expect(mono.at(-1)).toContain('$900.00')
  })

  it('lines the schedule columns up inside the renderer width', () => {
    for (const block of paymentPlanDocumentBlocks(FACTS).filter((b) => b.kind === 'mono')) {
      for (const line of block.text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(PLAN_SCHEDULE_WIDTH)
      }
    }
  })

  it('says the rent is still due, quotes what was agreed, and names the grace period', () => {
    const text = paymentPlanDocumentBlocks(FACTS)
      .map((b) => b.text)
      .join('\n')
    // LOAD-BEARING. Since R-187 a plan is only kept when the new rent is
    // paid too, so a tenant who read this as "instead of the rent" would
    // break the plan by doing what the paper told them.
    expect(text).toContain(PLAN_RENT_STILL_DUE)
    expect(text).toContain(PLAN_NOT_A_WAIVER)
    expect(text).toContain(`more than ${PLAN_GRACE_DAYS} days`)
    // The operator's own words, not a paraphrase.
    expect(text).toContain('“Three payments; she starts the new job on the 14th.”')
  })

  it('shows every signer unsigned on the draft and named on the executed copy', () => {
    const draft = paymentPlanDocumentBlocks(FACTS)
      .map((b) => b.text)
      .join('\n')
    expect(draft).toContain('Resident 1: Jordan Ruiz — not yet signed')
    expect(draft).toContain('Resident 2: Cara Diaz — not yet signed')

    const executed = paymentPlanDocumentBlocks({
      ...FACTS,
      signers: [
        {
          order: 1,
          role: 'TENANT' as const,
          name: 'Jordan Ruiz',
          signedAt: '12 Sep 2026',
          signedName: 'Jordan A Ruiz',
        },
        {
          order: 2,
          role: 'TENANT' as const,
          name: 'Cara Diaz',
          signedAt: '12 Sep 2026',
          signedName: 'Cara Diaz',
        },
      ],
    })
      .map((b) => b.text)
      .join('\n')
    // The name they TYPED, not the one staff entered - that is the fact a
    // dispute over identity turns on.
    expect(executed).toContain('Resident 1: Jordan A Ruiz — signed electronically 12 Sep 2026')
    expect(executed).not.toContain('not yet signed')
  })
})
