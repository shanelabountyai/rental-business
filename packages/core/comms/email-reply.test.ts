import { describe, expect, it } from 'vitest'
import {
  emailAddressOnly,
  emailOptOutConfirmation,
  extractReplyKey,
  isEmailOptOutRequest,
  htmlToText,
  isReplyKey,
  replyAddress,
  stripQuotedReply,
} from './email-reply.ts'

// Inbound email threading (COMM-08, R-097a).

const KEY = 'k7x2ab34cd56ef78gh90ij12'
const INBOUND = { inboundLocalPart: 'hello', inboundDomain: 'inbound.example.com' }

describe('the address out of a header', () => {
  // THE DEFECT GOLDEN PATH 4 FOUND (D-132). This was inline in
  // `extractReplyKey` and applied to recipients only, so `From:` - which is
  // what the ROUTING compares - kept its display name and matched no tenant.
  it('unwraps the display-name form every real client sends', () => {
    expect(emailAddressOnly('Dorothy Vaughan <d@example.com>')).toBe('d@example.com')
  })

  it('keeps a bare address, which providers also send', () => {
    expect(emailAddressOnly('  D@Example.com ')).toBe('d@example.com')
  })

  it('is not confused by a comma inside the display name', () => {
    // The second way the old code broke: `addresses()` split the From: header
    // on commas first, leaving `"Vaughan` as the sender.
    expect(emailAddressOnly('"Vaughan, Dorothy" <d@example.com>')).toBe('d@example.com')
  })
})

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

describe('HTML-only email', () => {
  it('keeps the words when there is no plain-text part', () => {
    // R-097a stored an empty string here, so a tenant who typed a paragraph
    // got a record saying they said nothing.
    expect(htmlToText('<p>The boiler is making a noise.</p>')).toBe(
      'The boiler is making a noise.',
    )
  })

  it('keeps paragraph structure rather than one run-on sentence', () => {
    expect(htmlToText('<p>First.</p><p>Second.</p>')).toBe('First.\nSecond.')
    expect(htmlToText('Line one.<br>Line two.')).toBe('Line one.\nLine two.')
  })

  it('drops a stylesheet rather than filing it as body text', () => {
    expect(htmlToText('<head><style>p{color:red}</style></head><p>Hello.</p>')).toBe('Hello.')
    expect(htmlToText('<script>alert(1)</script><p>Hello.</p>')).toBe('Hello.')
  })

  it('decodes the entities that actually turn up, and leaves the rest alone', () => {
    expect(htmlToText('<p>Tom &amp; Jerry&apos;s tap &lt;dripping&gt;</p>')).toBe(
      "Tom & Jerry's tap <dripping>",
    )
    expect(htmlToText('<p>&#8364;50</p>')).toBe('€50')
    // A wrong guess is a changed sentence in an evidence trail; a visible
    // entity is a cosmetic blemish.
    expect(htmlToText('<p>&hellip;</p>')).toBe('&hellip;')
  })

  it('marks list items so a list still reads as one', () => {
    expect(htmlToText('<ul><li>Tap</li><li>Boiler</li></ul>')).toBe('• Tap\n• Boiler')
  })

  it('collapses the indentation mail HTML is full of', () => {
    expect(htmlToText('<div>\n    <p>   Spaced   out   </p>\n</div>')).toBe('Spaced out')
  })
})

describe('"stop emailing me" (R-097e)', () => {
  it('recognises the ways people actually ask', () => {
    for (const body of [
      'Please unsubscribe me.',
      'Can you stop emailing me about this',
      'Remove me from your mailing list please',
      'I want to opt out of these',
      "Don't email me again",
      'No more emails thanks',
    ]) {
      expect(isEmailOptOutRequest(body), body).toBe(true)
    }
  })

  it('does NOT fire on a message about a repair', () => {
    // The expensive mistake here is the opposite of the SMS one: a tenant
    // whose rent reminders were silently switched off because they wrote
    // "stop" in a sentence about a tap gets a late fee. Every phrase is
    // multi-word for exactly this reason, and "stop" alone is not one.
    for (const body of [
      'The tap will not stop dripping.',
      'Stop the water at the main, the photo shows where it is.',
      'The boiler stops and starts all night.',
      'Please remove the old fridge from the garage.',
      'Can you take me through how the thermostat works?',
    ]) {
      expect(isEmailOptOutRequest(body), body).toBe(false)
    }
  })

  it('reads the STRIPPED body, so a quoted footer is not a request', () => {
    // Almost every marketing email ever sent has "unsubscribe" in its
    // footer, so a reply quoting one would otherwise opt somebody out every
    // single time.
    const raw = 'Thursday is fine.\n\nOn Mon, we wrote:\n> ... click here to unsubscribe'
    expect(isEmailOptOutRequest(stripQuotedReply(raw))).toBe(false)
    expect(isEmailOptOutRequest(raw)).toBe(true)
  })
})

describe('the opt-out confirmation', () => {
  const confirmation = emailOptOutConfirmation({
    businessName: 'Rental Operations',
    stoppedCount: 4,
    stillSending: [
      { label: 'Entry notices', explanation: 'Required by law in most states.' },
      { label: 'Legal notices', explanation: 'Must reach you to be effective.' },
    ],
  })

  it('says what will STILL arrive, which is the point of sending it', () => {
    // A tenant who believes they switched off every email and then misses an
    // entry notice has been misled by us.
    expect(confirmation.body).toContain('Entry notices')
    expect(confirmation.body).toContain('Required by law')
    expect(confirmation.body).toContain('cannot afford to miss')
  })

  it('offers a way back', () => {
    expect(confirmation.body).toContain('reply to this message')
  })

  it('reads sensibly when nothing is locked', () => {
    const none = emailOptOutConfirmation({
      businessName: 'Rental Operations',
      stoppedCount: 0,
      stillSending: [],
    })
    expect(none.body).not.toContain('•')
    expect(none.body).toContain('stopped sending you')
  })
})
