import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { feedWindow } from './queries.ts'

// What a staff calendar feed must never be able to read (NOTIF-06, R-097c).
//
// A SOURCE-LEVEL TEST, the shape R-092's export established and for the
// identical reason: a query that starts selecting one more column produces a
// feed that renders perfectly and leaks, and nothing about the OUTPUT can
// catch it. This feed leaves the building further than the handoff packet
// does — it ends up on a phone, in a desktop client and inside a cloud
// calendar, three copies with their own sharing features.
//
// It reads code lines only (R-103's rule), because the file's own header
// quotes both column names while explaining why they are absent.

const SOURCE = join(import.meta.dirname, 'queries.ts')

function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return (
        trimmed !== '' &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('///')
      )
    })
}

describe('the calendar feed’s exclusions', () => {
  const lines = codeLines(SOURCE)

  it('never selects a work order’s restricted-party note', () => {
    // R-091 puts a household member's name in that column for a locksmith
    // standing at a door; D-107 is what says it goes no further. The JOB is
    // on the calendar, correctly - D-109 says a case's consequences cannot
    // be hidden and somebody has to attend it.
    for (const line of lines) expect(line, line.trim()).not.toContain('restrictedPartyNote')
  })

  it('never selects a work order’s free-text scope', () => {
    // Written by whoever raised the job and able to say anything at all,
    // including things about a household. A closed vocabulary of visit KINDS
    // cannot.
    for (const line of lines) expect(line, line.trim()).not.toMatch(/\bscope:\s*true/)
  })

  it('never SELECTS a tenant, a prospect or anybody’s contact details', () => {
    // Somebody standing outside a door needs the address and the time. They
    // have the app for the rest, and a tenant's phone number in a shared work
    // calendar is a disclosure nobody consented to.
    //
    // MATCHED AS SELECTION SYNTAX, not as the word. The first version of
    // this failed on the string "A prospective tenant is viewing this unit",
    // which is prose the feed is supposed to carry - and a test that cries
    // wolf on correct code teaches the next person to weaken it (R-103).
    for (const line of lines) {
      expect(line, line.trim()).not.toMatch(/\b(tenant|prospect|leaseTenants|guarantor)s?\s*:/i)
      expect(line, line.trim()).not.toMatch(/\b(email|phone|firstName|lastName)\s*:\s*true/)
    }
  })

  it('never reaches into the confidential module', () => {
    for (const line of lines) expect(line, line.trim()).not.toContain('confidential')
  })
})

describe('the window', () => {
  it('keeps this morning’s visit and reaches a quarter ahead', () => {
    const now = new Date('2026-09-01T12:00:00Z')
    const window = feedWindow(now)
    // Backwards, so a visit that happened this morning is still on the
    // calendar when somebody looks at the day.
    expect(window.from.getTime()).toBeLessThan(now.getTime())
    expect(window.to.getTime()).toBeGreaterThan(now.getTime() + 60 * 24 * 60 * 60_000)
  })
})
