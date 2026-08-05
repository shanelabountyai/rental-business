import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decideSmsIntake,
  formatSmsTicketDescription,
  isOpenTicketStatus,
  verifyTwilioSignature,
} from './index.ts'

// R-021's two pure decisions: is this request really from Twilio, and does
// this text open a ticket.

const AUTH_TOKEN = '12345678901234567890123456789012'
const URL = 'https://example.test/api/sms/inbound'

/// Signs exactly the way Twilio documents it, so these tests exercise the
/// real algorithm rather than a mirror of our own implementation's bugs.
function sign(
  params: Record<string, string>,
  token = AUTH_TOKEN,
  url = URL,
): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  return createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64')
}

describe('verifyTwilioSignature', () => {
  const params = {
    From: '+15125550142',
    Body: 'The kitchen tap is dripping',
    MessageSid: 'SM123',
  }

  it('accepts a correctly signed request', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signature: sign(params),
      }),
    ).toBe(true)
  })

  it('sorts parameters by key, not by insertion order', () => {
    // Twilio sorts; a naive implementation using Object.keys order would
    // pass this test's happy path and fail against real traffic, where the
    // form field order is whatever the HTTP body happened to carry.
    const reordered = {
      MessageSid: 'SM123',
      Body: 'The kitchen tap is dripping',
      From: '+15125550142',
    }
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: reordered,
        signature: sign(params),
      }),
    ).toBe(true)
  })

  it('REFUSES a forged signature', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signature: 'not-the-real-signature',
      }),
    ).toBe(false)
  })

  it('REFUSES a request signed with the wrong token', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signature: sign(params, 'a-different-account-token-000000'),
      }),
    ).toBe(false)
  })

  it('REFUSES a tampered body, even with an otherwise valid signature', () => {
    // The attack this exists to stop: replaying a real, signed request with
    // the message body swapped for something else.
    const signature = sign(params)
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: { ...params, Body: 'Please transfer my deposit to this account' },
        signature,
      }),
    ).toBe(false)
  })

  it('REFUSES a tampered From, which is what decides whose thread it joins', () => {
    const signature = sign(params)
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: { ...params, From: '+15125559999' },
        signature,
      }),
    ).toBe(false)
  })

  it('REFUSES a signature computed for a different URL', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signature: sign(params, AUTH_TOKEN, 'https://evil.test/api/sms/inbound'),
      }),
    ).toBe(false)
  })

  it('REFUSES when no signature is present at all', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params,
        signature: null,
      }),
    ).toBe(false)
  })

  it('REFUSES when the auth token is empty', () => {
    // A missing token must never mean "skip the check". The route refuses
    // outright before reaching here; this is the second line of that defence.
    expect(
      verifyTwilioSignature({
        authToken: '',
        url: URL,
        params,
        signature: sign(params),
      }),
    ).toBe(false)
  })

  it('handles an empty parameter set without throwing', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: {},
        signature: sign({}),
      }),
    ).toBe(true)
  })
})

describe('decideSmsIntake', () => {
  it('opens a ticket when the tenant has nothing open', () => {
    expect(decideSmsIntake([])).toEqual({ outcome: 'open_ticket' })
  })

  it('threads into an existing open ticket rather than opening a second', () => {
    // The rule that keeps a conversation from becoming five tickets. A
    // tenant mid-thread types "thanks" - that is not a new problem.
    expect(decideSmsIntake([{ id: 't1', status: 'TRIAGED' }])).toEqual({
      outcome: 'thread_only',
      existingTicketId: 't1',
    })
  })

  it('treats every live status as open', () => {
    for (const status of ['NEW', 'TRIAGED', 'WAITING_ON_TENANT', 'CONVERTED']) {
      expect(isOpenTicketStatus(status), status).toBe(true)
      expect(decideSmsIntake([{ id: 't1', status }]).outcome, status).toBe(
        'thread_only',
      )
    }
  })

  it('opens a new ticket after the previous one closed or merged', () => {
    // A text three weeks after the last thing was resolved really is a new
    // problem, and burying it in a closed ticket would lose it.
    for (const status of ['CLOSED', 'MERGED']) {
      expect(isOpenTicketStatus(status), status).toBe(false)
      expect(decideSmsIntake([{ id: 't1', status }]), status).toEqual({
        outcome: 'open_ticket',
      })
    }
  })

  it('picks the newest open ticket when several are open', () => {
    // Callers pass newest-first; a further text is most likely about the
    // most recent thing.
    expect(
      decideSmsIntake([
        { id: 'newest', status: 'NEW' },
        { id: 'older', status: 'TRIAGED' },
      ]),
    ).toEqual({ outcome: 'thread_only', existingTicketId: 'newest' })
  })

  it('skips closed tickets to find an open one', () => {
    expect(
      decideSmsIntake([
        { id: 'closed', status: 'CLOSED' },
        { id: 'open', status: 'NEW' },
      ]),
    ).toEqual({ outcome: 'thread_only', existingTicketId: 'open' })
  })
})

describe('formatSmsTicketDescription', () => {
  it('leads with the tenant’s own words, verbatim', () => {
    const text = formatSmsTicketDescription('  Water heater is leaking  ')
    expect(text.startsWith('Water heater is leaking')).toBe(true)
  })

  it('tells whoever triages it that the sender may not use the portal', () => {
    // The operational point of MAINT-01's SMS path: replying through a
    // portal the tenant has never opened is not a reply.
    const text = formatSmsTicketDescription('no hot water')
    expect(text).toContain('reply by text')
  })
})
