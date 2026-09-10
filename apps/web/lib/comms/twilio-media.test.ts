import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTwilioMedia, parseTwilioMedia } from './twilio-media.ts'

// Bringing an MMS photograph back from Twilio (R-189).
//
// The fetch is stubbed rather than pointed at a server, because what is
// under test is the set of refusals - a non-Twilio host, an oversized body,
// a failed request - and each of those is a decision made before or after
// the network rather than by it. `handleInboundSms`'s own test covers what
// happens to the bytes once they arrive.

const AUTH = { accountSid: 'AC_test', authToken: 'token_test' }

afterEach(() => {
  vi.unstubAllGlobals()
})

/// One canned response, with whatever headers the case needs.
function respondWith(
  body: Buffer,
  headers: Record<string, string> = { 'content-type': 'image/jpeg' },
): typeof fetch {
  return vi.fn(async () =>
    new Response(new Uint8Array(body), { status: 200, headers }),
  ) as unknown as typeof fetch
}

describe('parseTwilioMedia', () => {
  it('reads nothing off an ordinary text', () => {
    expect(parseTwilioMedia({ From: '+15125550000', Body: 'the sink leaks' })).toEqual({
      declared: 0,
      media: [],
    })
  })

  it('pairs each URL with the type Twilio signed for it', () => {
    expect(
      parseTwilioMedia({
        NumMedia: '2',
        MediaUrl0: 'https://api.twilio.com/a/Media/ME1',
        MediaContentType0: 'image/jpeg',
        MediaUrl1: 'https://api.twilio.com/a/Media/ME2',
        MediaContentType1: 'application/pdf',
      }),
    ).toEqual({
      declared: 2,
      media: [
        { url: 'https://api.twilio.com/a/Media/ME1', contentType: 'image/jpeg' },
        { url: 'https://api.twilio.com/a/Media/ME2', contentType: 'application/pdf' },
      ],
    })
  })

  it('reports what NumMedia CLAIMED even when the URLs are missing', () => {
    // The declared count is what the unrouted queue records as dropped, so
    // it must survive a payload we could not act on - a triager needs to
    // know a photograph existed in order to ask for it again.
    const { declared, media } = parseTwilioMedia({ NumMedia: '1' })
    expect(declared).toBe(1)
    expect(media).toHaveLength(0)
  })

  it('will not be talked into a thousand outbound fetches', () => {
    // NumMedia is a string off a form. Trusting it to be small is how one
    // signed webhook becomes a fetch storm.
    const params: Record<string, string> = { NumMedia: '5000' }
    for (let i = 0; i < 5000; i += 1) params[`MediaUrl${i}`] = `https://api.twilio.com/m/${i}`
    const { declared, media } = parseTwilioMedia(params)
    expect(declared).toBe(5000)
    expect(media).toHaveLength(10)
  })

  it('treats rubbish in NumMedia as no media at all', () => {
    expect(parseTwilioMedia({ NumMedia: 'lots' }).declared).toBe(0)
    expect(parseTwilioMedia({ NumMedia: '-3' }).declared).toBe(0)
  })
})

describe('fetchTwilioMedia', () => {
  it('sends the account credentials and returns the bytes', async () => {
    const stub = respondWith(Buffer.alloc(64, 9))
    vi.stubGlobal('fetch', stub)

    const [attachment] = await fetchTwilioMedia(
      [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC_test/Media/ME1', contentType: 'image/jpeg' }],
      AUTH,
    )

    expect(attachment?.content).toHaveLength(64)
    expect(attachment?.contentType).toBe('image/jpeg')
    // Named for how it arrived rather than for an opaque ME… identifier:
    // Document.fileName is what staff read on the screen.
    expect(attachment?.fileName).toBe('texted-1.jpeg')

    const [, init] = (stub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const expected = `Basic ${Buffer.from('AC_test:token_test').toString('base64')}`
    expect((init as RequestInit).headers).toMatchObject({ authorization: expected })
  })

  it('REFUSES A HOST THAT IS NOT TWILIO, and does not dial it at all', async () => {
    // The URL arrives signed, so it is authentic - but the request carries
    // HTTP Basic auth for the whole account, and a credential a payload can
    // aim anywhere is the wrong shape whatever guards it today.
    const stub = respondWith(Buffer.alloc(8))
    vi.stubGlobal('fetch', stub)

    const attackerHosts = [
      'https://api.twilio.com.evil.test/m/1',
      'https://evil.test/m/1',
      'http://api.twilio.com/m/1',
      'file:///etc/passwd',
      'not a url at all',
    ]
    const kept = await fetchTwilioMedia(
      attackerHosts.map((url) => ({ url, contentType: 'image/jpeg' })),
      AUTH,
    )

    expect(kept).toHaveLength(0)
    expect(stub).not.toHaveBeenCalled()
  })

  it('refuses an oversized body on Content-Length, before reading it', async () => {
    const stub = respondWith(Buffer.alloc(8), {
      'content-type': 'image/jpeg',
      'content-length': String(16 * 1024 * 1024),
    })
    vi.stubGlobal('fetch', stub)

    expect(
      await fetchTwilioMedia([{ url: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' }], AUTH),
    ).toHaveLength(0)
  })

  it('drops what Twilio refuses to serve without costing the others', async () => {
    // One failed media item must never cost the message, and must not cost
    // the photograph that DID come back either.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        url.pathname.endsWith('/1')
          ? new Response('gone', { status: 404 })
          : new Response(new Uint8Array(Buffer.alloc(32, 1)), {
              status: 200,
              headers: { 'content-type': 'image/png' },
            }),
      ),
    )

    const kept = await fetchTwilioMedia(
      [
        { url: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' },
        { url: 'https://api.twilio.com/m/2', contentType: 'image/png' },
      ],
      AUTH,
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]!.fileName).toBe('texted-2.png')
  })

  it('does not throw when the network does', async () => {
    // A throw here becomes a 500 for Twilio, which retries, which duplicates
    // a text we have already recorded.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timed out')
      }),
    )
    expect(
      await fetchTwilioMedia([{ url: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' }], AUTH),
    ).toEqual([])
  })
})
