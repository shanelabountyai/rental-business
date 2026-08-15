import { describe, expect, it } from 'vitest'
import {
  MERGE_FIELDS,
  languageFor,
  mergeFieldsUsed,
  renderTemplate,
  unknownMergeFields,
  validateTemplate,
} from './merge-fields.ts'
import type { Translation } from './merge-fields.ts'

describe('the merge-field catalogue', () => {
  it('offers no internal identifiers (D-10)', () => {
    // A catalogue that offers `lease.id` is an invitation to put one in a
    // tenant-facing message. The absence is the design, so it gets a test
    // rather than a comment somebody deletes.
    for (const field of MERGE_FIELDS) {
      expect(field.key).not.toMatch(/(^|\.)id$/)
      expect(field.key).not.toMatch(/status|ticket_number|work_order/)
    }
  })

  it('offers no field that would require a jurisdiction decision', () => {
    // What a late fee should be is a per-lease, per-day question core answers
    // from versioned rules (D-4/D-12). A template quoting one would quote a
    // number nobody computed for this tenancy.
    const keys = MERGE_FIELDS.map((f) => f.key)
    expect(keys).not.toContain('balance.late_fee')
    expect(keys).not.toContain('lease.grace_period')
  })
})

describe('finding merge fields in a body', () => {
  it('reads them regardless of spacing and case', () => {
    expect(mergeFieldsUsed('Hi {{tenant.first_name}} / {{ TENANT.FIRST_NAME }}')).toEqual([
      'tenant.first_name',
    ])
  })

  it('returns each field once, in order of first appearance', () => {
    expect(
      mergeFieldsUsed('{{property.name}} — {{tenant.first_name}}, {{property.name}} again'),
    ).toEqual(['property.name', 'tenant.first_name'])
  })

  it('CATCHES A TYPO, which is the entire reason the catalogue is closed', () => {
    // `{{tenant.frist_name}}` compiles fine in a textarea. Nothing else in
    // this product would ever notice.
    expect(unknownMergeFields('Hi {{tenant.frist_name}},')).toEqual(['tenant.frist_name'])
  })

  it('treats a single brace as prose, not a field', () => {
    expect(mergeFieldsUsed('Rent is due on the {1st} of the month')).toEqual([])
  })
})

describe('validateTemplate', () => {
  const routine = {
    name: 'Welcome packet',
    kind: 'ROUTINE' as const,
    subject: 'Welcome to {{property.name}}',
    body: 'Hi {{tenant.first_name}}, welcome to {{property.address}}.',
  }

  it('accepts a template that only uses real fields', () => {
    expect(validateTemplate(routine)).toEqual([])
  })

  it('REFUSES an unknown field and NAMES it', () => {
    // "Invalid merge field" sends somebody hunting through their own
    // paragraph. Naming it is the difference between a five-second fix and an
    // abandoned template.
    const violations = validateTemplate({ ...routine, body: 'Hi {{tenant.frist_name}},' })
    expect(violations).toHaveLength(1)
    expect(violations[0].field).toBe('body')
    expect(violations[0].message).toContain('{{tenant.frist_name}}')
  })

  it('checks the subject line too', () => {
    const violations = validateTemplate({ ...routine, subject: 'Hello {{tenant.nickname}}' })
    expect(violations[0].message).toContain('{{tenant.nickname}}')
  })

  it('refuses a nameless or bodyless template', () => {
    expect(validateTemplate({ ...routine, name: '  ' })[0].field).toBe('name')
    expect(validateTemplate({ ...routine, body: '' }).some((v) => v.field === 'body')).toBe(true)
  })

  it('refuses a one-line LEGAL notice', () => {
    // Almost always a routine message somebody mislabelled — and the mislabel
    // runs the wrong way, locking it to approved translations it will never
    // have.
    const violations = validateTemplate({ ...routine, kind: 'LEGAL', body: 'Please pay.' })
    expect(violations.some((v) => v.message.includes('what is required'))).toBe(true)
  })
})

describe('renderTemplate', () => {
  it('fills what it has', () => {
    expect(
      renderTemplate('Hi {{tenant.first_name}}, rent is {{lease.rent}}.', {
        'tenant.first_name': 'Dana',
        'lease.rent': '$1,500.00',
      }),
    ).toEqual({ text: 'Hi Dana, rent is $1,500.00.', missing: [] })
  })

  it('NEVER PRINTS "undefined" AND NEVER PRINTS A BLANK', () => {
    // The two failure modes the typed templates got for free. "Your lease
    // ends on ." reads as a broken system; "Hi undefined" reads as worse.
    const result = renderTemplate('Your lease ends on {{lease.ends_on}}.', {
      'lease.ends_on': null,
    })
    expect(result.text).toBe('Your lease ends on {{lease.ends_on}}.')
    expect(result.text).not.toContain('undefined')
    expect(result.missing).toEqual(['lease.ends_on'])
  })

  it('treats an empty string as missing, not as a value', () => {
    // A month-to-month lease has no end date, and the database says so with
    // an empty value as readily as with a null.
    expect(renderTemplate('{{lease.ends_on}}', { 'lease.ends_on': '' }).missing).toEqual([
      'lease.ends_on',
    ])
  })

  it('reports a field missing once however often it appears', () => {
    expect(
      renderTemplate('{{balance.total}} and again {{balance.total}}', {}).missing,
    ).toEqual(['balance.total'])
  })

  it('does not re-scan a value that itself looks like a token', () => {
    // A tenant legitimately named "{{" is absurd; a BALANCE rendered from
    // upstream text is not. One pass only — a template must never be able to
    // expand into another template.
    const result = renderTemplate('Hi {{tenant.first_name}}', {
      'tenant.first_name': '{{company.name}}',
      'company.name': 'Cedar Row Rentals',
    })
    expect(result.text).toBe('Hi {{company.name}}')
  })
})

describe('languageFor — the rule this item cannot get wrong (COMM-03)', () => {
  const approved: Translation = {
    locale: 'es',
    subject: 'Aviso',
    body: '…',
    approvedAt: new Date('2026-01-01'),
  }
  const unapproved: Translation = { locale: 'es', subject: 'Aviso', body: '…', approvedAt: null }

  it('uses an APPROVED translation for a legal notice', () => {
    expect(languageFor('LEGAL', 'es', [approved])).toEqual({
      use: 'translation',
      locale: 'es',
      approved: true,
    })
  })

  it('REFUSES AN UNAPPROVED TRANSLATION FOR A LEGAL NOTICE', () => {
    // A mistranslated cure period is not a typo. It is a defective notice the
    // tenant relied on.
    expect(languageFor('LEGAL', 'es', [unapproved])).toEqual({
      use: 'default',
      reason: 'unapproved_translation_for_legal',
    })
  })

  it('ALLOWS an unapproved translation for routine chat', () => {
    // COMM-03 permits machine translation for routine messages, and a rent
    // reminder a tenant can read beats one they cannot.
    expect(languageFor('ROUTINE', 'es', [unapproved])).toEqual({
      use: 'translation',
      locale: 'es',
      approved: false,
    })
  })

  it('falls back rather than refusing to send, and says which reason', () => {
    // A tenant who chose Spanish receiving English is worse than receiving an
    // approved Spanish notice, and better than receiving nothing at all.
    const outcome = languageFor('LEGAL', 'es', [unapproved])
    expect(outcome.use).toBe('default')
    expect(outcome).not.toHaveProperty('blocked')
  })

  it('distinguishes "no translation exists" from "one exists unapproved"', () => {
    // They need different follow-up: one is a translation to commission, the
    // other is a translation to get reviewed. Collapsing them loses that.
    expect(languageFor('LEGAL', 'es', [])).toEqual({
      use: 'default',
      reason: 'no_translation',
    })
  })

  it('uses the default language when the tenant expressed no preference', () => {
    expect(languageFor('LEGAL', null, [approved]).use).toBe('default')
    expect(languageFor('LEGAL', 'en', [approved]).use).toBe('default')
  })

  it('ignores a translation in a language the tenant did not ask for', () => {
    const vietnamese: Translation = {
      locale: 'vi',
      subject: null,
      body: '…',
      approvedAt: new Date('2026-01-01'),
    }
    expect(languageFor('LEGAL', 'es', [vietnamese])).toEqual({
      use: 'default',
      reason: 'no_translation',
    })
  })
})
