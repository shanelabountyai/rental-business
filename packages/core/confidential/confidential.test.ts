import { describe, expect, it } from 'vitest'
import {
  BIFURCATION_IS_NOT_AN_EVICTION,
  BIFURCATION_REASON,
  DOCUMENTATION_IS_NOT_STORED,
  EARLY_TERMINATION_LIABILITY_NOTE,
  EARLY_TERMINATION_REFUSAL_MESSAGES,
  LOCK_CHANGE_SCOPE,
  earlyTermination,
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

describe('the statutory early-termination right (R-091b)', () => {
  const TX = {
    rightExists: true,
    noticeDays: 30,
    acceptedDocumentationTypes: ['PROTECTIVE_ORDER', 'PROVIDER_STATEMENT'],
  }
  const base = {
    deliveredOn: '2026-03-10',
    today: '2026-03-10',
    rule: TX,
    documentationType: 'PROTECTIVE_ORDER',
    documentedOn: '2026-03-09',
  }

  it('runs the notice period from the day notice was delivered', () => {
    expect(earlyTermination(base)).toEqual({ effectiveOn: '2026-04-09', noticeDays: 30 })
  })

  it('counts calendar days across a month end and a DST boundary', () => {
    // 2026-03-08 is the US DST switch. Calendar arithmetic, not 30 * 24h.
    expect(earlyTermination({ ...base, deliveredOn: '2026-03-01' }).effectiveOn).toBe('2026-03-31')
  })

  it('takes a zero-day notice period as a real rule, not a missing one', () => {
    // A state where the tenancy ends the day notice is delivered is
    // configuration, and `!noticeDays` would have refused it.
    const decision = earlyTermination({ ...base, rule: { ...TX, noticeDays: 0 } })
    expect(decision).toEqual({ effectiveOn: '2026-03-10', noticeDays: 0 })
  })

  it('distinguishes an unreviewed state from one that grants no right', () => {
    // The whole reason the column is three-valued. Both stop the statutory
    // path; only one of them is an answer about the law, and the operator has
    // to be able to tell which they are looking at.
    const unreviewed = earlyTermination({
      ...base,
      rule: { rightExists: null, noticeDays: null, acceptedDocumentationTypes: [] },
    })
    const refused = earlyTermination({
      ...base,
      rule: { rightExists: false, noticeDays: null, acceptedDocumentationTypes: [] },
    })
    expect(unreviewed.refusal).toBe('rule_not_reviewed')
    expect(refused.refusal).toBe('right_not_granted')
    expect(EARLY_TERMINATION_REFUSAL_MESSAGES.rule_not_reviewed).toContain(
      'not an answer about the law',
    )
  })

  it('refuses when the right exists but its notice period is not on file', () => {
    expect(
      earlyTermination({ ...base, rule: { ...TX, noticeDays: null } }).refusal,
    ).toBe('notice_period_not_configured')
  })

  it('needs documentation, and needs it to be a class this state accepts', () => {
    expect(
      earlyTermination({ ...base, documentationType: null, documentedOn: null }).refusal,
    ).toBe('no_documentation')
    // Recorded but with no date is the same gap: the CHECK on the case keeps
    // the pair whole, and a half-record must not buy the right either.
    expect(earlyTermination({ ...base, documentedOn: null }).refusal).toBe('no_documentation')
    expect(earlyTermination({ ...base, documentationType: 'POLICE_REPORT' }).refusal).toBe(
      'documentation_not_accepted',
    )
  })

  it('accepts any recorded class where the state has itemised none', () => {
    // An empty list means nobody filled that field in, NOT that the state
    // accepts nothing. Refusing there would be refusing somebody a statutory
    // right over a gap in our own configuration.
    const decision = earlyTermination({
      ...base,
      documentationType: 'POLICE_REPORT',
      rule: { ...TX, acceptedDocumentationTypes: [] },
    })
    expect(decision.effectiveOn).toBe('2026-04-09')
  })

  it('refuses a delivery date that has not happened', () => {
    expect(earlyTermination({ ...base, deliveredOn: '2026-03-11' }).refusal).toBe(
      'delivered_in_future',
    )
  })

  it('never names what the case is about, in any refusal message', () => {
    // The panel these render on is behind the wall, but a wall is not the
    // only way a screen gets read (D-107).
    for (const message of Object.values(EARLY_TERMINATION_REFUSAL_MESSAGES)) {
      for (const word of ['violence', 'abuse', 'assault', 'stalking', 'victim', 'survivor']) {
        expect(message.toLowerCase(), word).not.toContain(word)
      }
    }
  })

  it('states what the termination does and does not clear', () => {
    expect(EARLY_TERMINATION_LIABILITY_NOTE).toContain('already owed')
    expect(EARLY_TERMINATION_LIABILITY_NOTE).toContain('deposit')
  })
})

describe('removing the restricted party (R-091b)', () => {
  it('gives the amendment a fixed reason that discloses nothing', () => {
    // Printed on a document every signer reads, archived where
    // `document.read` reaches the maintenance tech, and copied into
    // `lease.party_changed`. A free-text box here is an invitation to type
    // the one sentence the whole feature exists to keep off those screens.
    for (const word of ['violence', 'abuse', 'assault', 'protective', 'restraining', 'safety']) {
      expect(BIFURCATION_REASON.toLowerCase(), word).not.toContain(word)
    }
    expect(BIFURCATION_REASON).toContain('statutory right')
  })

  it('says in as many words that it is not an eviction', () => {
    expect(BIFURCATION_IS_NOT_AN_EVICTION).toContain('self-help eviction')
  })
})
