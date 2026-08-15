import { describe, expect, it } from 'vitest'
import { chargebackDecision, chargebackNoticeText } from './chargeback.ts'
import type { ChargebackFacts } from './chargeback.ts'

const billable: ChargebackFacts = {
  status: 'CLOSED',
  tenantCaused: true,
  jobCostCents: 41_200,
  leaseId: 'lease_1',
  existingChargeId: null,
  requestedCents: 41_200,
}

describe('chargebackDecision', () => {
  it('allows the full repair cost on a closed, tenant-caused job', () => {
    expect(chargebackDecision(billable)).toEqual({
      allowed: true,
      amountCents: 41_200,
      partial: false,
    })
  })

  it('ALLOWS LESS THAN THE COST — the case this flow exists for', () => {
    // Betterment, shared fault, goodwill. Billing part of a repair is the
    // normal outcome, not an exception, and a flow that could only charge the
    // full invoice would be used by nobody or used dishonestly.
    expect(chargebackDecision({ ...billable, requestedCents: 15_000 })).toEqual({
      allowed: true,
      amountCents: 15_000,
      partial: true,
    })
  })

  it('REFUSES MORE THAN THE COST — at that point it is a penalty, not a chargeback', () => {
    expect(chargebackDecision({ ...billable, requestedCents: 41_201 })).toEqual({
      allowed: false,
      refusal: 'exceeds_job_cost',
    })
  })

  it('refuses a job that is not closed yet', () => {
    // It could still be reopened by the tenant or redone under warranty.
    expect(chargebackDecision({ ...billable, status: 'WORK_COMPLETE' }).refusal).toBe('not_closed')
  })

  it('refuses a job nobody marked tenant-caused', () => {
    // `unknown` and `normal_wear` both arrive here as false. Silence is not
    // consent: the close action deliberately refuses to infer the flag, and
    // this is the other half of that decision.
    expect(chargebackDecision({ ...billable, tenantCaused: false }).refusal).toBe(
      'not_tenant_caused',
    )
  })

  it('refuses a second charge on a job already billed', () => {
    expect(
      chargebackDecision({ ...billable, existingChargeId: 'chg_1' }).refusal,
    ).toBe('already_charged')
  })

  it('refuses a job with no tenancy to bill', () => {
    // A PM-raised job on a vacant unit. Normal, not an error — and the reason
    // this resolves to a refusal rather than a guess at the last tenant.
    expect(chargebackDecision({ ...billable, leaseId: null }).refusal).toBe('no_tenancy')
  })

  it('refuses a job that cost nothing, before complaining about the amount', () => {
    // Both refusals are true here. Reporting "you asked for more than it
    // cost" on a $0 job is accurate and useless — there is no amount that
    // would work.
    expect(
      chargebackDecision({ ...billable, jobCostCents: 0, requestedCents: 5_000 }).refusal,
    ).toBe('no_cost')
  })

  it('refuses zero, a negative, and a fractional cent', () => {
    for (const requestedCents of [0, -100, 1.5]) {
      expect(chargebackDecision({ ...billable, requestedCents }).refusal).toBe('zero_requested')
    }
  })

  it('reports the unbillable job before the unbillable amount', () => {
    // Ordering matters for the person reading it: "this was closed as normal
    // wear" sends them to the right screen, "fix the amount" sends them to
    // edit a number on a job that can never be billed.
    expect(
      chargebackDecision({
        ...billable,
        tenantCaused: false,
        requestedCents: 99_999_999,
      }).refusal,
    ).toBe('not_tenant_caused')
  })
})

describe('chargebackNoticeText', () => {
  const context = {
    tenantName: 'Dana Reyes',
    addressLine1: '18 Cedar Row',
    unitName: 'A',
    jobSummary: 'Replaced the garbage disposal, jammed by a spoon.',
    completedOn: '2026-08-12',
    jobCostCents: 41_200,
    amountCents: 15_000,
    reason: 'Cutlery in the disposal is not normal wear.',
    evidenceCount: 3,
  }

  it('SHOWS THE ARITHMETIC when the tenant is billed less than the cost', () => {
    const text = chargebackNoticeText(context)
    // The most useful line in the message: billed $150 of a $412 repair reads
    // as a decision made in their favour. "$150" alone reads as invented.
    expect(text).toContain('The repair cost $412.00')
    expect(text).toContain('You are being charged $150.00 of that amount — not the full cost.')
  })

  it('does not claim a discount that was not given', () => {
    const text = chargebackNoticeText({ ...context, amountCents: 41_200 })
    expect(text).not.toContain('not the full cost')
    expect(text).toContain('that is the amount being charged')
  })

  it('answers all four questions a tenant would otherwise call about', () => {
    const text = chargebackNoticeText(context)
    expect(text).toContain(context.jobSummary) // what was repaired
    expect(text).toContain('$412.00') // what it cost
    expect(text).toContain(context.reason) // why it is theirs, verbatim
    expect(text).toContain('If you disagree with this charge') // how to disagree
  })

  it('says disputing is not a failure to pay rent', () => {
    // Without this the only way left to disagree is to withhold rent, which
    // is the outcome the notice exists to prevent.
    expect(chargebackNoticeText(context)).toContain(
      'Disputing a repair charge is not a failure to pay rent',
    )
  })

  it('promises the evidence, and counts it correctly for one item', () => {
    expect(chargebackNoticeText(context)).toContain('3 documents and photos are attached')
    expect(chargebackNoticeText({ ...context, evidenceCount: 1 })).toContain(
      '1 document or photo is attached',
    )
  })

  it('offers the evidence anyway when none is attached', () => {
    // A job with no photos is a weaker chargeback, not a licence to say
    // nothing about what the tenant may see.
    const text = chargebackNoticeText({ ...context, evidenceCount: 0 })
    expect(text).toContain('You are entitled to see the contractor invoice')
    expect(text).not.toContain('attached to this repair in your portal')
  })

  it('carries the draft disclaimer every legal artifact here carries (D-4)', () => {
    expect(chargebackNoticeText(context)).toContain('has not been reviewed by an attorney')
  })
})
