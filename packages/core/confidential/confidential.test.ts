import { describe, expect, it } from 'vitest'
import {
  DOCUMENTATION_IS_NOT_STORED,
  LOCK_CHANGE_SCOPE,
  restrictedPartyNote,
  validateConfidentialCase,
  type ConfidentialCaseInput,
} from './index.ts'

// RISK-04 (R-091). Two things are worth a test here and neither is the
// validation: that the note handed to a locksmith names only who IS
// authorized, and that nothing this module produces says why the job exists.

const base: ConfidentialCaseInput = {
  summary: 'Tenant reported an incident and asked for the locks to be changed.',
  restrictedPartyName: '',
  restrictedPartyTenantId: null,
  documentationType: '',
  documentedOn: '',
  today: '2026-08-24',
}

function fields(input: ConfidentialCaseInput) {
  return validateConfidentialCase(input).map((v) => v.field)
}

describe('validateConfidentialCase', () => {
  it('opens on a summary alone — documentation is never required to act', () => {
    // The whole point. A survivor who has not been to court has no order to
    // show, and a product that would not change the locks until they did
    // would hold somebody's safety against a filing deadline.
    expect(fields(base)).toEqual([])
  })

  it('requires a summary', () => {
    expect(fields({ ...base, summary: '   ' })).toEqual(['summary'])
  })

  it('takes documentation whole or not at all', () => {
    expect(fields({ ...base, documentationType: 'PROTECTIVE_ORDER' })).toEqual(['documentedOn'])
    expect(fields({ ...base, documentedOn: '2026-08-20' })).toEqual(['documentedOn'])
    expect(
      fields({ ...base, documentationType: 'PROTECTIVE_ORDER', documentedOn: '2026-08-20' }),
    ).toEqual([])
  })

  it('refuses a documentation class it does not recognise, and a future date', () => {
    expect(
      fields({ ...base, documentationType: 'HEARSAY', documentedOn: '2026-08-20' }),
    ).toEqual(['documentationType'])
    expect(
      fields({ ...base, documentationType: 'POLICE_REPORT', documentedOn: '2026-09-01' }),
    ).toEqual(['documentedOn'])
  })

  it('will not take a tenant id with no name', () => {
    // The database enforces the same pairing from the other side. A case that
    // points at a Tenant row and does not say who they are stops reading the
    // moment that row is retired.
    expect(fields({ ...base, restrictedPartyTenantId: 't-1' })).toEqual([
      'restrictedPartyName',
    ])
    expect(
      fields({ ...base, restrictedPartyTenantId: 't-1', restrictedPartyName: 'Sam Doe' }),
    ).toEqual([])
  })
})

describe('restrictedPartyNote', () => {
  const note = restrictedPartyNote({
    authorizedNames: ['Jane Doe'],
    callbackLabel: 'Sam Rivera on 555-0100',
  })

  it('names who may be given keys', () => {
    expect(note).toContain('ONLY to Jane Doe')
    expect(note).toContain('Sam Rivera on 555-0100')
  })

  // ==========================================================================
  // THE TEST THIS MODULE EXISTS FOR.
  //
  // A locksmith told "do not give keys to John Smith" has been told something
  // about a household that is not theirs to know, and that they may repeat to
  // the next person who asks. Naming only the authorized party is the same
  // protection with nothing disclosed. If a later edit ever adds the
  // restricted party's name to this string, this is the test that has to be
  // deleted first.
  // ==========================================================================
  it('never names the restricted party, and never says why the job exists', () => {
    const withRestricted = restrictedPartyNote({
      authorizedNames: ['Jane Doe'],
      callbackLabel: 'the office',
    })
    expect(withRestricted).not.toContain('John Smith')
    for (const word of ['violence', 'abuse', 'assault', 'safety', 'protective', 'restraining']) {
      expect(withRestricted.toLowerCase(), word).not.toContain(word)
      expect(LOCK_CHANGE_SCOPE.toLowerCase(), word).not.toContain(word)
    }
  })

  it('falls back to the property manager when nobody is left to authorize', () => {
    // A whole-tenancy case where the only occupant IS the restricted party.
    // The keys go to the office rather than to nobody, which is what a
    // locksmith holding a fresh set actually needs told.
    expect(restrictedPartyNote({ authorizedNames: [], callbackLabel: 'the office' })).toContain(
      'ONLY to the property manager',
    )
  })
})

describe('the documentation warning', () => {
  // The operator's intuitive move is to scan the protective order into the
  // filing cabinet, where `document.read` puts it in front of the maintenance
  // tech. The warning has to say so in as many words or it will not work.
  it('tells the operator not to upload the document, and why', () => {
    expect(DOCUMENTATION_IS_NOT_STORED).toContain('Do not upload')
    expect(DOCUMENTATION_IS_NOT_STORED).toContain('maintenance')
  })
})
