import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUIET_HOURS,
  DIGEST_ELIGIBLE_CATEGORIES,
  LOCKED_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  bypassesQuietHours,
  channelsFor,
  defaultEnabled,
  isDigestEligible,
  isLockedCategory,
  isNotificationCategory,
  mayAutoRetry,
  quietHoursEndAfter,
  renderTemplate,
  resolveChannels,
  templateFor,
  withinQuietHours,
} from './index.ts'

const CHICAGO = 'America/Chicago'

describe('the category vocabulary', () => {
  it('recognises a real category and rejects an invented one', () => {
    expect(isNotificationCategory('rent_reminder')).toBe(true)
    expect(isNotificationCategory('rentReminder')).toBe(false)
  })

  it('gives every locked category an explanation', () => {
    // NOTIF-02 asks for "locked on WITH EXPLANATION" - a locked toggle with no
    // reason next to it is the half of the story that reads as a bug.
    for (const [category, reason] of Object.entries(LOCKED_CATEGORIES)) {
      expect(isNotificationCategory(category)).toBe(true)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it('locks the two categories NOTIF-02 names', () => {
    expect(isLockedCategory('legal_notice')).toBe(true)
    expect(isLockedCategory('maintenance_emergency')).toBe(true)
    expect(isLockedCategory('rent_reminder')).toBe(false)
  })

  it('lets only genuine emergencies through quiet hours', () => {
    expect(bypassesQuietHours('maintenance_emergency')).toBe(true)
    // Locked is not the same as urgent: a legal notice cannot be silenced but
    // has no reason to arrive at 3am.
    expect(bypassesQuietHours('legal_notice')).toBe(false)
    expect(bypassesQuietHours('rent_reminder')).toBe(false)
  })

  it('defaults SMS off for routine categories and on for urgent ones', () => {
    expect(defaultEnabled('rent_reminder', 'SMS')).toBe(false)
    expect(defaultEnabled('rent_reminder', 'EMAIL')).toBe(true)
    expect(defaultEnabled('payment_failed', 'SMS')).toBe(true)
    expect(defaultEnabled('legal_notice', 'SMS')).toBe(true)
  })
})

describe('NOTIF-04 digest eligibility (R-054)', () => {
  it('marks only the categories named as batchable', () => {
    expect(isDigestEligible('rent_reminder')).toBe(true)
    expect(isDigestEligible('announcement')).toBe(true)
    // Money-timing, prompt-decision and clock-starting categories all stay
    // immediate.
    expect(isDigestEligible('payment_failed')).toBe(false)
    expect(isDigestEligible('autopay_predebit')).toBe(false)
    expect(isDigestEligible('approval_needed')).toBe(false)
    expect(isDigestEligible('vendor_response')).toBe(false)
    expect(isDigestEligible('move_out')).toBe(false)
    expect(isDigestEligible('work_order_assigned')).toBe(false)
  })

  it('never makes a locked category batchable', () => {
    // LOCKED_CATEGORIES always sends regardless of preference, so this would
    // be dead code either way - asserted so the two lists cannot silently
    // start disagreeing.
    for (const category of DIGEST_ELIGIBLE_CATEGORIES) {
      expect(isLockedCategory(category)).toBe(false)
    }
  })

  it('defaults the digest itself to OFF, unlike every other EMAIL default', () => {
    expect(defaultEnabled('digest_daily', 'EMAIL')).toBe(false)
    expect(defaultEnabled('rent_reminder', 'EMAIL')).toBe(true)
  })

  it('restricts the digest category to EMAIL, and leaves everything else at every channel', () => {
    expect(channelsFor('digest_daily')).toEqual(['EMAIL'])
    expect(channelsFor('rent_reminder')).toEqual(['EMAIL', 'SMS', 'PORTAL'])
  })
})

describe('resolveChannels', () => {
  it('sends on a channel with no stored preference, using the default', () => {
    const decisions = resolveChannels({
      category: 'rent_reminder',
      candidates: ['EMAIL', 'SMS'],
      preferences: [],
    })
    expect(decisions).toEqual([
      { channel: 'EMAIL', send: true },
      { channel: 'SMS', send: false, reason: 'preference_off' },
    ])
  })

  it('honours an explicit opt-in that overrides a default-off channel', () => {
    const decisions = resolveChannels({
      category: 'rent_reminder',
      candidates: ['SMS'],
      preferences: [{ category: 'rent_reminder', channel: 'SMS', enabled: true }],
    })
    expect(decisions[0]).toEqual({ channel: 'SMS', send: true })
  })

  it('honours an explicit opt-out that overrides a default-on channel', () => {
    const decisions = resolveChannels({
      category: 'rent_reminder',
      candidates: ['EMAIL'],
      preferences: [
        { category: 'rent_reminder', channel: 'EMAIL', enabled: false },
      ],
    })
    expect(decisions[0]).toEqual({
      channel: 'EMAIL',
      send: false,
      reason: 'preference_off',
    })
  })

  it('ignores a preference row that would silence a locked category', () => {
    // The backstop for NOTIF-02. The settings screen refuses to create such a
    // row, but a row written before the category was locked - or by a direct
    // database edit - must not be able to suppress a legal notice.
    const decisions = resolveChannels({
      category: 'legal_notice',
      candidates: ['EMAIL', 'SMS'],
      preferences: [
        { category: 'legal_notice', channel: 'EMAIL', enabled: false },
        { category: 'legal_notice', channel: 'SMS', enabled: false },
      ],
    })
    expect(decisions.every((decision) => decision.send)).toBe(true)
  })

  it('ignores preference rows belonging to other categories', () => {
    const decisions = resolveChannels({
      category: 'rent_reminder',
      candidates: ['EMAIL'],
      preferences: [
        { category: 'move_out', channel: 'EMAIL', enabled: false },
      ],
    })
    expect(decisions[0]!.send).toBe(true)
  })
})

describe('quiet hours', () => {
  it('treats 22:00 local as quiet and 10:00 local as not', () => {
    // 03:00 UTC is 21:00 the previous day in Chicago (CDT, UTC-5).
    expect(withinQuietHours(new Date('2026-08-05T03:00:00Z'), CHICAGO)).toBe(true)
    expect(withinQuietHours(new Date('2026-08-05T15:00:00Z'), CHICAGO)).toBe(false)
  })

  it('is decided in property-local time, not UTC', () => {
    // One instant, two properties: 05:00 UTC is midnight in Chicago (quiet)
    // and 19:00 the previous day in Honolulu (not quiet). A UTC-based check
    // would have to be wrong for one of them.
    const instant = new Date('2026-08-05T05:00:00Z')
    expect(withinQuietHours(instant, CHICAGO)).toBe(true)
    expect(withinQuietHours(instant, 'Pacific/Honolulu')).toBe(false)
  })

  it('resumes at the top of the local end hour', () => {
    const resumeAt = quietHoursEndAfter(
      new Date('2026-08-05T03:30:00Z'),
      CHICAGO,
    )
    expect(withinQuietHours(resumeAt, CHICAGO)).toBe(false)
    // 08:00 America/Chicago in August (CDT, UTC-5) is 13:00 UTC.
    expect(resumeAt.toISOString()).toBe('2026-08-05T13:00:00.000Z')
  })

  it('lands on a real local 08:00 across the spring-forward transition', () => {
    // 2026-03-08 is the US spring-forward date: 02:00 local does not exist.
    // The window still has to end at a real 08:00, which is 13:00 UTC (CDT).
    const resumeAt = quietHoursEndAfter(
      new Date('2026-03-08T04:00:00Z'),
      CHICAGO,
    )
    expect(withinQuietHours(resumeAt, CHICAGO)).toBe(false)
    expect(resumeAt.toISOString()).toBe('2026-03-08T13:00:00.000Z')
  })

  it('lands on a real local 08:00 across the fall-back transition', () => {
    // 2026-11-01: 01:00 local happens twice. The extra hour must not push the
    // result past 08:00 or leave it inside the window.
    const resumeAt = quietHoursEndAfter(
      new Date('2026-11-01T04:00:00Z'),
      CHICAGO,
    )
    expect(withinQuietHours(resumeAt, CHICAGO)).toBe(false)
    // 08:00 America/Chicago on 2026-11-01 is CST (UTC-6) = 14:00 UTC.
    expect(resumeAt.toISOString()).toBe('2026-11-01T14:00:00.000Z')
  })

  it('handles a same-day window as well as an overnight one', () => {
    const daytimeQuiet = { startHour: 13, endHour: 17 }
    // 19:00 UTC is 14:00 in Chicago - inside a 13:00-17:00 window.
    expect(
      withinQuietHours(new Date('2026-08-05T19:00:00Z'), CHICAGO, daytimeQuiet),
    ).toBe(true)
    expect(
      withinQuietHours(new Date('2026-08-05T23:00:00Z'), CHICAGO, daytimeQuiet),
    ).toBe(false)
  })

  it('uses 21:00-08:00 as the shipped default', () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ startHour: 21, endHour: 8 })
  })
})

describe('templates', () => {
  it('renders the one template R-016 ships, per channel', () => {
    const context = { propertyName: 'Magnolia Drive House', unitName: 'ADU' }
    const email = renderTemplate('unit.make_ready', context, 'EMAIL')
    expect(email.subject).toContain('ADU')
    expect(email.subject).toContain('Magnolia Drive House')
    expect(email.body).toContain('make-ready')

    const portal = renderTemplate('unit.make_ready', context, 'PORTAL')
    expect(portal.body).toContain('ADU')
  })

  it('throws on an unregistered key rather than rendering nothing', () => {
    expect(() => renderTemplate('nope.not_a_template', {}, 'EMAIL')).toThrow(
      /No notification template registered/,
    )
  })

  it('registers every template under a real category', () => {
    // A template whose category is not in the vocabulary would resolve
    // preferences and quiet hours against a category nothing else knows.
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(isNotificationCategory(category)).toBe(true)
    }
    const template = templateFor('unit.make_ready')
    expect(template).toBeDefined()
    expect(isNotificationCategory(template!.category)).toBe(true)
  })

  it('renders the digest as a numbered list of what was batched', () => {
    const rendered = renderTemplate(
      'notifications.digest_daily',
      {
        items: [
          { subject: 'Rent is due in 3 days', body: 'fallback body one' },
          { subject: null, body: 'No subject line for this one\nsecond line' },
        ],
      },
      'EMAIL',
    )
    expect(rendered.subject).toContain('2 updates')
    expect(rendered.body).toContain('1. Rent is due in 3 days')
    // Falls back to the first line of the body when a channel (SMS,
    // typically) had no subject to render.
    expect(rendered.body).toContain('2. No subject line for this one')
    expect(rendered.body).not.toContain('second line')
  })
})

describe('mayAutoRetry', () => {
  it('never re-sends a notice on its own', () => {
    // Serving a notice starts a clock. A second copy carries a second
    // timestamp, and nobody chose to send it.
    expect(mayAutoRetry('legal_notice')).toBe(false)
    expect(mayAutoRetry('entry_notice')).toBe(false)
  })

  it('is not the locked list', () => {
    // Locked means "you may not switch this off"; this means "we may not
    // repeat it without you". A failed gas-leak page is the one that most
    // wants retrying, and it is locked.
    expect(isLockedCategory('maintenance_emergency')).toBe(true)
    expect(mayAutoRetry('maintenance_emergency')).toBe(true)
    expect(mayAutoRetry('lease_signature')).toBe(true)
    expect(mayAutoRetry('rent_reminder')).toBe(true)
  })
})
