import { describe, expect, it } from 'vitest'
import { consentVerdict, coversPurpose } from './consent.ts'

describe('coversPurpose — only express written reaches marketing', () => {
  it('lets every basis carry a transactional message', () => {
    for (const basis of ['EXPRESS_WRITTEN', 'EXISTING_RELATIONSHIP', 'VERBAL', 'IMPORTED'] as const) {
      expect(coversPurpose(basis, 'TRANSACTIONAL')).toBe(true)
    }
  })

  it('lets ONLY express written carry a promotional one', () => {
    expect(coversPurpose('EXPRESS_WRITTEN', 'PROMOTIONAL')).toBe(true)
    for (const basis of ['EXISTING_RELATIONSHIP', 'VERBAL', 'IMPORTED'] as const) {
      expect(coversPurpose(basis, 'PROMOTIONAL')).toBe(false)
    }
  })
})

describe('consentVerdict', () => {
  const relationship = { channel: 'SMS', basis: 'EXISTING_RELATIONSHIP', revokedAt: null }
  const written = { channel: 'SMS', basis: 'EXPRESS_WRITTEN', revokedAt: null }

  it('allows a tenancy message on the backfilled basis', () => {
    // The grandfathering decision: an existing roster keeps its rent
    // reminders rather than going silent the moment the gate ships.
    expect(consentVerdict([relationship], 'SMS', 'TRANSACTIONAL')).toEqual({
      allowed: true,
      reason: null,
    })
  })

  it('refuses a marketing message on that same basis', () => {
    expect(consentVerdict([relationship], 'SMS', 'PROMOTIONAL')).toEqual({
      allowed: false,
      reason: 'basis_too_weak',
    })
  })

  it('DISTINGUISHES never-agreed from took-it-back', () => {
    // Different facts with different fixes: a gap somebody can close by
    // asking, versus a decision to honour. Collapsing them would hide a
    // withdrawal behind an oversight.
    expect(consentVerdict([], 'SMS', 'TRANSACTIONAL').reason).toBe('no_consent_on_file')
    expect(
      consentVerdict([{ ...relationship, revokedAt: new Date() }], 'SMS', 'TRANSACTIONAL').reason,
    ).toBe('consent_withdrawn')
  })

  it('is scoped per channel — email consent does not authorise a text', () => {
    expect(
      consentVerdict([{ channel: 'EMAIL', basis: 'EXPRESS_WRITTEN', revokedAt: null }], 'SMS', 'TRANSACTIONAL')
        .reason,
    ).toBe('no_consent_on_file')
  })

  it('takes the STRONGEST live record, not the newest', () => {
    // A backfilled existing-relationship row landing after a real written
    // consent must not downgrade the tenant.
    expect(consentVerdict([written, relationship], 'SMS', 'PROMOTIONAL').allowed).toBe(true)
    expect(consentVerdict([relationship, written], 'SMS', 'PROMOTIONAL').allowed).toBe(true)
  })

  it('ignores a withdrawn strong record in favour of a live weak one', () => {
    const verdict = consentVerdict(
      [{ ...written, revokedAt: new Date() }, relationship],
      'SMS',
      'PROMOTIONAL',
    )
    // The written consent is gone, so marketing is barred - but the tenancy
    // relationship survives, so this is "too weak", not "withdrawn".
    expect(verdict).toEqual({ allowed: false, reason: 'basis_too_weak' })
  })
})
