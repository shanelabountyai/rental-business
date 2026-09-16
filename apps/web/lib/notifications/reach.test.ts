import { describe, expect, it } from 'vitest'
import type { ChannelOutcome } from '@/lib/notifications/send.ts'
import { entryNoticeClause, reachOf } from './reach.ts'

const ZONE = 'America/Chicago'

function outcome(partial: Partial<ChannelOutcome>): ChannelOutcome {
  return { channel: 'SMS', outcome: 'recorded', ...partial }
}

describe('reachOf (R-211)', () => {
  it('is SENT when any real channel is going now', () => {
    expect(
      reachOf([
        outcome({ status: 'QUEUED' }),
        outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
      ]).status,
    ).toBe('SENT')
  })

  it('IS NOT SENT when every channel was suppressed, and names each reason', () => {
    // The defect the row exists for: the guarantor with no TCPA consent and
    // the tenant who texted STOP were both counted as reached.
    const reach = reachOf([
      outcome({ status: 'SUPPRESSED', reason: 'no_consent' }),
      outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
    ])
    expect(reach.status).toBe('NOT_SENT')
    expect(reach.why).toContain('no consent to text them on file')
    expect(reach.why).toContain('no email or phone we may use')
  })

  it('says one reason once when both channels give it', () => {
    expect(
      reachOf([
        outcome({ status: 'SUPPRESSED', reason: 'no_address' }),
        outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
      ]).why,
    ).toBe('no email or phone we may use')
  })

  it('A PORTAL ROW IS NOT REACHING ANYBODY', () => {
    // R-173's phone-only tenant gets a live PORTAL row and cannot sign in.
    // Counting it would put the lie straight back (R-216 owns the sign-in).
    const reach = reachOf([
      outcome({ channel: 'PORTAL', status: 'QUEUED' }),
      outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'no_address' }),
    ])
    expect(reach.status).toBe('NOT_SENT')
  })

  it('counts a digest-batched email as reaching them', () => {
    // `rent_reminder` is digest-eligible, so this is live for the chase.
    // Reporting it unsent would make a PM re-send by hand and double-message
    // the tenant - the opposite lie, and the worse one.
    expect(reachOf([outcome({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'digest_batched' })]).status).toBe(
      'SENT',
    )
  })

  it('separates DEFERRED from sent, and carries the EARLIEST hour', () => {
    const reach = reachOf([
      outcome({ status: 'DEFERRED', sendAfter: new Date('2026-08-05T19:00:00Z') }),
      outcome({ channel: 'EMAIL', status: 'DEFERRED', sendAfter: new Date('2026-08-05T13:00:00Z') }),
    ])
    expect(reach.status).toBe('DEFERRED')
    expect(reach.sendAfter).toEqual(new Date('2026-08-05T13:00:00Z'))
  })

  it('reports a duplicate as already sent, never as not sent', () => {
    expect(reachOf([outcome({ outcome: 'duplicate' })]).status).toBe('ALREADY_SENT')
  })

  it('does not invent a reason the engine did not record', () => {
    expect(reachOf([outcome({ status: 'SUPPRESSED' })]).why).toBe('the reason was not recorded')
  })
})

describe('entryNoticeClause (R-211)', () => {
  it('tells the operator to serve it themselves when nothing went', () => {
    const clause = entryNoticeClause(
      { status: 'NOT_SENT', why: 'no email or phone we may use' },
      ZONE,
    )
    expect(clause).toContain('HAS NOT BEEN TOLD')
    expect(clause).toContain('Serve the notice yourself')
  })

  it('names the property-local hour a deferred notice actually goes out', () => {
    // 13:00 UTC is 08:00 in Chicago in August.
    const clause = entryNoticeClause(
      { status: 'DEFERRED', sendAfter: new Date('2026-08-05T13:00:00Z') },
      ZONE,
    )
    expect(clause).toContain('08:00 CDT')
    expect(clause).not.toContain('has been told')
  })

  it('says the tenant has been told only when they have', () => {
    expect(entryNoticeClause({ status: 'SENT' }, ZONE)).toBe('and the tenant has been told')
  })
})
