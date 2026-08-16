import { describe, expect, it } from 'vitest'
import { NOTICE_DISCLAIMER, noticeDocumentBlocks } from './document.ts'
import {
  parseServiceMethodMap,
  serviceMethodsFor,
  serviceStandingLabel,
  servicePermitted,
} from './service-methods.ts'

const TX = {
  noticeServiceMethods: {
    NOTICE_TO_VACATE: ['PERSONAL', 'CERTIFIED_MAIL', 'POSTED_WITH_PHOTO'],
    RENT_INCREASE: ['PERSONAL', 'EMAIL', 'PORTAL'],
  },
}

describe('servicePermitted — three answers, not two', () => {
  it('says yes for a method the state lists', () => {
    expect(servicePermitted(TX, 'NOTICE_TO_VACATE', 'CERTIFIED_MAIL')).toBe(true)
  })

  it('says NO for a method the state omits from a configured type', () => {
    // Email is deliberately absent from the eviction track: a notice that
    // cannot be proved served starts a clock the landlord cannot defend.
    expect(servicePermitted(TX, 'NOTICE_TO_VACATE', 'EMAIL')).toBe(false)
  })

  it('IS NULL, NOT FALSE, when the state has no rule at all', () => {
    // The distinction the whole module exists to hold: "we do not know what
    // this state allows" is not an accusation, and must never read as one.
    expect(servicePermitted(null, 'NOTICE_TO_VACATE', 'EMAIL')).toBeNull()
    expect(servicePermitted({}, 'NOTICE_TO_VACATE', 'EMAIL')).toBeNull()
  })

  it('is null for a notice type the configured state does not mention', () => {
    // A state that configured its eviction notices and not its entry ones
    // has said nothing about entry notices - not "no method serves them".
    expect(servicePermitted(TX, 'ENTRY_NOTICE', 'PORTAL')).toBeNull()
  })

  it('distinguishes an EXPLICITLY EMPTY list from an absent one', () => {
    // "This state permits none of the methods we can record" is a real, if
    // unusual, answer and must not read back as unconfigured.
    const none = { noticeServiceMethods: { PAY_OR_QUIT: [] } }
    expect(serviceMethodsFor(none, 'PAY_OR_QUIT')).toEqual([])
    expect(servicePermitted(none, 'PAY_OR_QUIT', 'PERSONAL')).toBe(false)
  })
})

describe('parseServiceMethodMap — total and forgiving', () => {
  it('returns null for shapes it cannot understand rather than throwing', () => {
    // The column is Json and holds whatever was put there. One
    // badly-configured state must not 500 the notice screen for the other
    // forty-nine.
    for (const bad of [null, undefined, 'NOTICE_TO_VACATE', 42, ['PERSONAL']]) {
      expect(parseServiceMethodMap(bad)).toBeNull()
    }
  })

  it('drops unknown method names but keeps the rest of the list', () => {
    const parsed = parseServiceMethodMap({
      PAY_OR_QUIT: ['PERSONAL', 'CARRIER_PIGEON', 'CERTIFIED_MAIL'],
    })
    expect(parsed).toEqual({ PAY_OR_QUIT: ['PERSONAL', 'CERTIFIED_MAIL'] })
  })

  it('skips a non-array value without discarding sibling types', () => {
    const parsed = parseServiceMethodMap({
      PAY_OR_QUIT: 'PERSONAL',
      RENT_INCREASE: ['EMAIL'],
    })
    expect(parsed).toEqual({ RENT_INCREASE: ['EMAIL'] })
  })
})

describe('serviceStandingLabel', () => {
  it('never calls an unverified method impermissible', () => {
    expect(serviceStandingLabel(null)).toMatch(/unverified/i)
    expect(serviceStandingLabel(null)).not.toMatch(/not permitted/i)
    expect(serviceStandingLabel(false)).toMatch(/not permitted/i)
    expect(serviceStandingLabel(true)).toMatch(/permitted/i)
  })
})

describe('noticeDocumentBlocks', () => {
  const facts = {
    noticeType: 'NOTICE_TO_VACATE',
    addressOfRecord: '9 Rent Roll Road, Houston, TX 77002',
    propertyName: 'Roll House',
    unitName: 'Main house',
    tenantNames: ['Ada Tenant', 'Bo Tenant'],
    bodyText: 'You must vacate.\n\nThe reason is non-payment of rent.',
    generatedOn: '2026-08-16',
  }

  it('names EVERY tenant on the tenancy', () => {
    // A notice addressed to one of two tenants is a notice the other can say
    // they never received.
    const to = noticeDocumentBlocks(facts).find((b) => b.text.startsWith('To:'))
    expect(to?.text).toContain('Ada Tenant')
    expect(to?.text).toContain('Bo Tenant')
  })

  it('splits the body on blank lines so the renderer never guesses a break', () => {
    const paragraphs = noticeDocumentBlocks(facts).filter((b) => b.kind === 'paragraph')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[1].text).toContain('non-payment')
  })

  it('ALWAYS ends with the not-legal-advice disclaimer (D-4)', () => {
    const blocks = noticeDocumentBlocks(facts)
    expect(blocks[blocks.length - 1].text).toBe(NOTICE_DISCLAIMER)
    expect(NOTICE_DISCLAIMER).toContain('not legal advice')
  })

  it('falls back to "Occupant" rather than addressing nobody', () => {
    const blocks = noticeDocumentBlocks({ ...facts, tenantNames: [] })
    expect(blocks.find((b) => b.text.startsWith('To:'))?.text).toContain('Occupant')
  })

  it('carries the statute citation when there is one', () => {
    const blocks = noticeDocumentBlocks({ ...facts, citation: 'Tex. Prop. Code §24.005' })
    expect(blocks.some((b) => b.text.includes('§24.005'))).toBe(true)
  })
})
