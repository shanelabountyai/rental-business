import { describe, expect, it } from 'vitest'
import type { ChannelOutcome } from '@/lib/notifications/send.ts'
import { vendorDispatchNotice } from './dispatch-notice.ts'

const ZONE = 'America/Chicago'

function outcome(partial: Partial<ChannelOutcome>): ChannelOutcome {
  return { channel: 'SMS', outcome: 'recorded', ...partial }
}

describe('vendorDispatchNotice (R-207)', () => {
  it('reports a send when any channel is going now', () => {
    expect(
      vendorDispatchNotice(
        [
          outcome({ status: 'QUEUED' }),
          outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
        ],
        'Ace Plumbing',
        ZONE,
      ),
    ).toBe('Link sent to Ace Plumbing.')
  })

  it('names the hour a deferred link will actually go out', () => {
    // The defect this row exists for: the screen said "Link sent" over an
    // eleven-hour wait. 13:00 UTC is 08:00 in Chicago in August.
    const notice = vendorDispatchNotice(
      [
        outcome({ status: 'DEFERRED', sendAfter: new Date('2026-08-05T13:00:00Z') }),
        outcome({ channel: 'EMAIL', status: 'DEFERRED', sendAfter: new Date('2026-08-05T13:00:00Z') }),
      ],
      'Ace Plumbing',
      ZONE,
    )
    expect(notice).toContain('08:00 CDT')
    expect(notice).not.toContain('sent')
  })

  it('says nothing went out when every channel was suppressed', () => {
    const notice = vendorDispatchNotice(
      [
        outcome({ status: 'SUPPRESSED', reason: 'no_address' }),
        outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
      ],
      'Ace Plumbing',
      ZONE,
    )
    expect(notice).toContain('Not sent to Ace Plumbing')
  })

  it('does not claim a NEW send for a duplicate, which carries no status', () => {
    // A resend the engine swallowed as already-decided is not a new send -
    // but R-211 corrected R-207's wording here: it is not a FAILURE either,
    // and "Not sent" told the PM to go and call a vendor who already had the
    // link.
    const notice = vendorDispatchNotice([outcome({ outcome: 'duplicate' })], 'Ace Plumbing', ZONE)
    expect(notice).toBe('Link already sent to Ace Plumbing.')
  })
})
