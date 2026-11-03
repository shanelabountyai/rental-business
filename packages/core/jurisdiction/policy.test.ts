import { describe, expect, it } from 'vitest'
import { applyOrgPolicy } from './policy.ts'

const statute = { graceDays: 2, lateFeeMaxCents: 5000, entryNoticeHours: 24 }
const none = { policyGraceDays: null, policyLateFeeMaxCents: null, policyEntryNoticeHours: null }

describe('applyOrgPolicy', () => {
  it('leaves the statute alone with no policy', () => {
    expect(applyOrgPolicy(statute, null)).toEqual({ ...statute, policyApplied: [] })
    expect(applyOrgPolicy(statute, none)).toEqual({ ...statute, policyApplied: [] })
  })

  it('takes the stricter policy: more grace, lower cap, longer notice', () => {
    const merged = applyOrgPolicy(statute, {
      policyGraceDays: 5,
      policyLateFeeMaxCents: 2500,
      policyEntryNoticeHours: 48,
    })
    expect(merged).toEqual({
      graceDays: 5,
      lateFeeMaxCents: 2500,
      entryNoticeHours: 48,
      policyApplied: ['graceDays', 'lateFeeMaxCents', 'entryNoticeHours'],
    })
  })

  it('never takes a looser policy, and an equal one is still the statute', () => {
    const merged = applyOrgPolicy(statute, {
      policyGraceDays: 1,
      policyLateFeeMaxCents: 5000,
      policyEntryNoticeHours: 12,
    })
    expect(merged).toEqual({ ...statute, policyApplied: [] })
  })

  it('fills a number the statute has not been taught', () => {
    const merged = applyOrgPolicy(
      { graceDays: 0, lateFeeMaxCents: null, entryNoticeHours: null },
      { policyGraceDays: null, policyLateFeeMaxCents: 0, policyEntryNoticeHours: 24 },
    )
    expect(merged).toEqual({
      graceDays: 0,
      lateFeeMaxCents: 0,
      entryNoticeHours: 24,
      policyApplied: ['lateFeeMaxCents', 'entryNoticeHours'],
    })
  })

  it('does not mutate the statute row', () => {
    const row = { ...statute }
    applyOrgPolicy(row, { ...none, policyGraceDays: 9 })
    expect(row).toEqual(statute)
  })
})
