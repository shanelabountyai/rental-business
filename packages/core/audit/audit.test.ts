import { Prisma } from '@rental/db'
import { describe, expect, it } from 'vitest'
import { PRIVILEGED_PERMISSIONS } from '../rbac/permissions.ts'
import {
  AUDIT_ACTIONS,
  REASON_CODES,
  REASON_REQUIRED,
  isAuditAction,
  isReasonCode,
  requiresReason,
} from './events.ts'
import {
  ALWAYS_SAFE,
  REDACTED,
  changedFields,
  isSensitiveField,
  redact,
} from './redact.ts'

describe('redaction', () => {
  it.each([
    'password',
    'passwordHash',
    'mfaSecret',
    'mfaRecoveryCodes',
    'tokenHash',
    'resetToken',
    'webhookSecret',
    'stripeWebhookSecret',
    'apiKey',
    'accessCode',
    'lockboxCode',
    'smartLockCode',
    'ssn',
    'accountNumber',
  ])('treats %s as sensitive', (field) => {
    expect(isSensitiveField(field)).toBe(true)
  })

  // Over-redaction damages the trail this item exists to build. A content
  // hash on a document is evidence that the file was not swapped.
  it.each([
    'sha256',
    'name',
    'amountCents',
    'rentCents',
    'storageKey',
    'stripeCustomerId',
    'addressLine1',
    'capturedAt',
  ])('leaves %s alone', (field) => {
    expect(isSensitiveField(field)).toBe(false)
  })

  it('replaces sensitive values with a marker rather than dropping the key', () => {
    const output = redact({ email: 'a@b.test', passwordHash: 'scrypt$...' }) as
      Record<string, unknown>
    // "This changed and we are not saying to what" is a true audit statement;
    // a missing key is indistinguishable from a field nobody touched.
    expect(output).toEqual({ email: 'a@b.test', passwordHash: REDACTED })
    expect('passwordHash' in output).toBe(true)
  })

  it('redacts nested and arrayed values', () => {
    expect(
      redact({
        staff: { mfaSecret: 'JBSWY3DP', lastLoginAt: '2026-08-01' },
        users: [{ password: 'hunter2', name: 'Dana' }],
      }),
    ).toEqual({
      staff: { mfaSecret: REDACTED, lastLoginAt: '2026-08-01' },
      users: [{ password: REDACTED, name: 'Dana' }],
    })
  })

  // A sensitive NAME redacts whatever it holds, object or not. Recursing into
  // it instead would leak a secret stored under a key the walker did not
  // recognise, and losing a couple of sibling fields is the cheaper mistake.
  it('redacts a whole object when the container name is sensitive', () => {
    expect(redact({ credential: { anything: 'at all' } })).toEqual({
      credential: REDACTED,
    })
  })

  // Benign fields the broad patterns would otherwise catch. This is the only
  // opt-out, so each one is a deliberate line in ALWAYS_SAFE.
  it.each(['postalCode', 'reasonCode', 'failureCode', 'statusCode'])(
    'exempts %s, which matches the pattern but holds no secret',
    (field) => {
      expect(isSensitiveField(field)).toBe(false)
    },
  )

  it('never redacts by sniffing values, only by field name', () => {
    // A rent amount that happens to look like a card number must survive.
    expect(redact({ rentCents: 4111111111111111 })).toEqual({
      rentCents: 4111111111111111,
    })
  })

  it('serialises dates rather than emitting empty objects', () => {
    const when = new Date('2026-08-01T12:00:00Z')
    expect(redact({ occurredAt: when })).toEqual({
      occurredAt: '2026-08-01T12:00:00.000Z',
    })
  })

  it('stops at a depth bound rather than hanging on a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => redact(cyclic)).not.toThrow()
  })
})

// The list above is a list, and lists rot. This walks the actual Prisma schema
// and fails when a field is added whose name looks sensitive but which
// redaction would let through - so a future `apiSecret` column cannot quietly
// start appearing in audit payloads.
describe('redaction keeps up with the schema', () => {
  const schemaFields = Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields.map((field) => ({ model: model.name, field: field.name })),
  )

  // The canary. Every schema field whose NAME looks like it could hold a
  // secret must be either redacted or explicitly exempted - so adding a
  // `gateCode` column forces a decision instead of silently landing in audit
  // payloads. Exemption is deliberate and reviewable; forgetting is not.
  it('handles every field in the schema that looks like a secret', () => {
    const looksSensitive = /password|secret|token|credential|apikey|ssn|codes?$/i
    const unhandled = schemaFields.filter(
      ({ field }) =>
        looksSensitive.test(field) &&
        !isSensitiveField(field) &&
        !ALWAYS_SAFE.has(field.toLowerCase()),
    )
    expect(unhandled).toEqual([])
  })

  it('exempts nothing that actually holds a secret', () => {
    for (const exempt of ALWAYS_SAFE) {
      expect(exempt).not.toMatch(/password|secret|token|ssn/i)
    }
  })

  it('actually redacts the known secret-bearing columns', () => {
    for (const field of [
      'passwordHash',
      'mfaSecret',
      'mfaRecoveryCodes',
      'tokenHash',
    ]) {
      expect(
        schemaFields.some((entry) => entry.field === field),
        `${field} is no longer in the schema - update this test`,
      ).toBe(true)
      expect(isSensitiveField(field)).toBe(true)
    }
  })
})

describe('changedFields', () => {
  it('keeps only what changed', () => {
    expect(
      changedFields(
        { rentCents: 185_000, status: 'ACTIVE', name: 'Main house' },
        { rentCents: 195_000, status: 'ACTIVE', name: 'Main house' },
      ),
    ).toEqual({
      before: { rentCents: 185_000 },
      after: { rentCents: 195_000 },
    })
  })

  it('reports nothing when nothing changed', () => {
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual({
      before: null,
      after: null,
    })
  })

  // Present on every write by definition; including it would bury the field
  // that mattered under noise in every single entry.
  it('ignores updatedAt', () => {
    expect(
      changedFields(
        { rentCents: 1, updatedAt: new Date('2026-01-01') },
        { rentCents: 1, updatedAt: new Date('2026-02-01') },
      ),
    ).toEqual({ before: null, after: null })
  })

  it('records a create whole', () => {
    expect(changedFields(null, { name: 'New' })).toEqual({
      before: null,
      after: { name: 'New' },
    })
  })

  it('records a delete whole', () => {
    expect(changedFields({ name: 'Gone' }, null)).toEqual({
      before: { name: 'Gone' },
      after: null,
    })
  })

  // The failure this whole module exists to prevent.
  it('redacts a secret even when the secret is the thing that changed', () => {
    expect(
      changedFields(
        { passwordHash: 'scrypt$old', email: 'a@b.test' },
        { passwordHash: 'scrypt$new', email: 'a@b.test' },
      ),
    ).toEqual({
      before: { passwordHash: REDACTED },
      after: { passwordHash: REDACTED },
    })
  })

  it('notices a changed array', () => {
    expect(
      changedFields({ trades: ['plumbing'] }, { trades: ['plumbing', 'hvac'] }),
    ).toEqual({
      before: { trades: ['plumbing'] },
      after: { trades: ['plumbing', 'hvac'] },
    })
  })

  it('compares dates by value, not by identity', () => {
    expect(
      changedFields(
        { servedAt: new Date('2026-01-01') },
        { servedAt: new Date('2026-01-01') },
      ),
    ).toEqual({ before: null, after: null })
  })

  it('treats null and a value as a change', () => {
    expect(changedFields({ servedAt: null }, { servedAt: '2026-01-01' })).toEqual(
      { before: { servedAt: null }, after: { servedAt: '2026-01-01' } },
    )
  })
})

describe('the audit vocabulary', () => {
  it('recognises its own actions and rejects invented ones', () => {
    expect(isAuditAction('fee.waived')).toBe(true)
    expect(isAuditAction('feeWaived')).toBe(false)
    expect(isAuditAction('lease.update')).toBe(false)
  })

  it('recognises its own reason codes', () => {
    expect(isReasonCode('goodwill')).toBe(true)
    expect(isReasonCode('because I said so')).toBe(false)
  })

  it('uses one naming shape throughout', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action, `${action} should be subject.past_tense`).toMatch(
        /^[a-z_]+\.[a-z_]+$/,
      )
    }
  })

  it('demands a reason exactly where "why" is the point', () => {
    expect(requiresReason('fee.waived')).toBe(true)
    expect(requiresReason('entry_notice.overridden')).toBe(true)
    // Signing in needs no justification.
    expect(requiresReason('auth.signed_in')).toBe(false)
    expect(requiresReason('accesscode.revealed')).toBe(false)
  })

  it('only requires reasons for actions it knows about', () => {
    for (const action of REASON_REQUIRED) {
      expect(AUDIT_ACTIONS).toContain(action)
    }
  })

  it('has a reason code for the fair-housing waiver report (PAY-04)', () => {
    // A waiver-pattern report by tenant needs a category to group by, which
    // free text cannot provide.
    expect(REASON_CODES).toContain('goodwill')
    expect(REASON_CODES).toContain('first_occurrence')
  })

  // ROLE-03's privileged list and R-004's MFA-gated permissions describe the
  // same set of actions from two directions. They are allowed to differ in
  // wording, but every gated permission needs somewhere to be recorded, or
  // the product gates an action it then forgets.
  it('can record every action R-004 treats as privileged', () => {
    const recordable: Record<string, string> = {
      'ledger.adjust': 'ledger.adjusted',
      'fee.waive': 'fee.waived',
      'workorder.approve': 'workorder.approved',
      'staff.manage': 'staff.assignment_granted',
      'document.delete': 'document.delete_marked',
      'accesscode.reveal': 'accesscode.revealed',
      'template.approve': 'template.translation_approved',
    }
    for (const permission of PRIVILEGED_PERMISSIONS) {
      const action = recordable[permission]
      expect(action, `no audit action for ${permission}`).toBeDefined()
      expect(AUDIT_ACTIONS).toContain(action)
    }
  })
})
