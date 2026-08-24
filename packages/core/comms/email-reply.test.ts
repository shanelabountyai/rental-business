import { describe, expect, it } from 'vitest'
import { extractReplyKey, isReplyKey, replyAddress, stripQuotedReply } from './email-reply.ts'

// Inbound email threading (COMM-08, R-097a).

const KEY = 'k7x2ab34cd56ef78gh90ij12'
const INBOUND = { inboundLocalPart: 'hello', inboundDomain: 'inbound.example.com' }

describe('the reply address', () => {
  it('plus-addresses the thread key', () => {
    expect(replyAddress({ ...INBOUND, replyKey: KEY })).toBe(`hello+${KEY}@inbound.example.com`)
  })
})

describe('reading the key back', () => {
  it('finds it on any recipient header, not just To:', () => {
    // A reply that CC'd the office and To'd a colleague still carries our
    // address somewhere.
    expect(
      extractReplyKey({ ...INBOUND, recipients: [`hello+${KEY}@inbound.example.com`] }),
    ).toBe(KEY)
    expect(
      extractReplyKey({
        ...INBOUND,
        recipients: ['someone@else.test', `Office <hello+${KEY}@Inbound.Example.COM>`],
      }),
    ).toBe(KEY)
  })

  it('ignores an address that is not ours', () => {
    expect(
      extractReplyKey({ ...INBOUND, recipients: [`hello+${KEY}@lookalike.example.com`] }),
    ).toBeNull()
    expect(
      extractReplyKey({ ...INBOUND, recipients: [`support+${KEY}@inbound.example.com`] }),
    ).toBeNull()
  })

  it('returns null rather than a partial key when the tag is not one', () => {
    // A stripped or mangled tag has to fall through to From: matching, not
    // route to whatever a truncated key happens to hit.
    expect(extractReplyKey({ ...INBOUND, recipients: ['hello@inbound.example.com'] })).toBeNull()
    expect(extractReplyKey({ ...INBOUND, recipients: ['hello+short@inbound.example.com'] }))
      .toBeNull()
  })

  it('does not truncate a key containing a plus', () => {
    // `a+b+c` is one tag with a plus in it, not two tags. Taking split()[1]
    // would silently hand back half a key.
    expect(isReplyKey(`${KEY}`)).toBe(true)
    expect(
      extractReplyKey({ ...INBOUND, recipients: [`hello+${KEY}+extra@inbound.example.com`] }),
    ).toBeNull()
  })
})

describe('stripping the quoted tail', () => {
  it('keeps what the person typed and drops what their client quoted', () => {
    const body = [
      'Yes, Thursday works.',
      '',
      'On Mon, 24 Aug 2026 at 09:00, Rental Operations wrote:',
      '> We can come Thursday between 9 and 11.',
      '> Let us know.',
    ].join('\n')
    expect(stripQuotedReply(body)).toBe('Yes, Thursday works.')
  })

  it('handles Outlook’s divider and a bare From: header', () => {
    expect(stripQuotedReply('Sounds good.\n\n-----Original Message-----\nFrom: someone'))
      .toBe('Sounds good.')
    expect(stripQuotedReply('Sounds good.\n\nFrom: Rental Operations\nSent: Monday'))
      .toBe('Sounds good.')
  })

  it('cuts at a signature separator', () => {
    expect(stripQuotedReply('Thanks.\n\n-- \nSent from my phone')).toBe('Thanks.')
  })

  it('normalises CRLF', () => {
    expect(stripQuotedReply('Line one.\r\n\r\n> quoted')).toBe('Line one.')
  })

  it('NEVER returns empty when there was any text at all', () => {
    // A reply that is nothing but a quote still has to be recorded: `Message`
    // is the evidence trail, and "they replied and it was blank" is itself a
    // fact. Better a long record than a missing one.
    const quoteOnly = '> We can come Thursday.\n> Let us know.'
    expect(stripQuotedReply(quoteOnly)).toBe(quoteOnly)
    expect(stripQuotedReply('   ')).toBe('')
  })

  it('leaves an ordinary message alone', () => {
    expect(stripQuotedReply('The boiler is making a noise again.')).toBe(
      'The boiler is making a noise again.',
    )
  })
})
