import 'server-only'

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type InboundAttachment,
} from './inbound-attachments.ts'

// Bringing back what a tenant texted (MAINT-01, COMM-08, R-189).
//
// ==========================================================================
// THE PHOTOGRAPH IS THE POINT. R-097d gave the EMAIL path attachments and
// this one never got them: `NumMedia` and `MediaUrl0…N` appeared nowhere in
// the repo, so the picture of the leak a tenant sends at 11pm was read off
// the wire and thrown away - on the channel R-021 measured as roughly half
// of all intake. Three things were lost each time: the vendor was dispatched
// blind, the append-only `Message` trail was missing content the tenant
// demonstrably sent, and since R-181 we texted back "we have your request"
// while the evidence was already gone.
//
// AN MMS DOES NOT CARRY ITS BYTES. Unlike an inbound-email webhook, which
// posts the attachment inline, Twilio posts URLs and expects us to go and
// GET them with the account's own credentials. That makes this the one place
// in inbound handling that opens an outbound connection, so:
//
//   * ONLY TWILIO'S OWN HOSTS, AND ONLY OVER TLS. The URL arrives inside a
//     signature-verified payload, so it is authentic - but the request
//     carries HTTP Basic auth for the whole account, and a credential that
//     can be pointed at an arbitrary host by a payload is the wrong shape
//     whatever guards it today.
//   * REDIRECTS ARE FOLLOWED, and Twilio's media URL always issues one, to
//     its CDN. The credential does not travel: fetch strips `Authorization`
//     on a cross-origin redirect, and the destination is Twilio's own CDN in
//     any case. Two independent reasons, because this one matters.
//   * A TIMEOUT AND A SIZE CAP. Twilio's own MMS ceiling is well under
//     `MAX_ATTACHMENT_BYTES`, and `Content-Length` is checked before the
//     body is read - but a lying header is only caught after buffering, so
//     the real ceiling on memory here is one CDN response, bounded by the
//     timeout. Worth knowing before this is pointed at any other provider.
//   * ONE FAILED MEDIA ITEM NEVER COSTS THE MESSAGE. The words are what must
//     survive; a fetch that fails is counted, not thrown.
//
// THE ACCOUNT SID COMES OFF THE SIGNED FORM, not from an environment
// variable, and that is deliberate: it means media works in exactly the
// configuration the route already demands (`TWILIO_AUTH_TOKEN` alone) rather
// than needing `TWILIO_ACCOUNT_SID`, which is only set once 10DLC clears and
// outbound is live. Inbound does not wait for outbound - `.env.example` has
// said so since R-021.
// ==========================================================================

/// The same 10s the outbound Twilio driver uses (`live-adapter.ts`). Ten
/// media in parallel, so the whole fetch is one timeout, not ten - Twilio's
/// webhook deadline is 15s and a 204 that arrives late is a redelivery.
const TIMEOUT_MS = 10_000

/// `api.twilio.com` and nothing else that is not under it. This is the host
/// the CREDENTIAL may be sent to, which is why it is narrow: the CDN Twilio
/// redirects to lives on a different domain and is reached without one,
/// through the redirect rather than through this check.
const TWILIO_HOST = /(^|\.)twilio\.com$/

export interface DeclaredMedia {
  url: string
  /// What Twilio says it is. Signed, and only ever used for the accept /
  /// refuse decision and the recorded `contentType` - nothing parses these
  /// bytes. `inbound-attachments.ts` holds the closed type list.
  contentType: string
}

/**
 * What the webhook form SAYS arrived, before anything is fetched.
 *
 * `declared` is `NumMedia` itself rather than the length of `media`, because
 * it is what the unrouted queue records as dropped - a triager needs to know
 * a photograph existed even when we could not bring it back, which is the
 * whole reason `UnroutedMessage.attachmentsDropped` is a number and not a
 * boolean.
 */
export function parseTwilioMedia(params: Record<string, string>): {
  declared: number
  media: DeclaredMedia[]
} {
  const parsed = Number.parseInt(params.NumMedia ?? '', 10)
  const declared = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const media: DeclaredMedia[] = []
  // Capped at the count `storeInboundAttachments` would keep anyway. The
  // loop bound is not a formality: `NumMedia` is a string off a form, and
  // trusting it to be small is how a signed request becomes a thousand
  // outbound fetches.
  for (let index = 0; index < Math.min(declared, MAX_ATTACHMENT_COUNT); index += 1) {
    const url = params[`MediaUrl${index}`]
    if (!url) continue
    media.push({
      url,
      contentType: params[`MediaContentType${index}`] ?? 'application/octet-stream',
    })
  }
  return { declared, media }
}

/**
 * Fetches the declared media, dropping whatever will not come back.
 *
 * Returns only what was retrieved. The caller reports `declared` separately,
 * so a fetch failure reads as "there was a photograph and we do not have it"
 * rather than as "there was no photograph".
 */
export async function fetchTwilioMedia(
  media: readonly DeclaredMedia[],
  auth: { accountSid: string; authToken: string },
): Promise<InboundAttachment[]> {
  const fetched = await Promise.all(media.map((item, index) => fetchOne(item, index, auth)))
  return fetched.filter((item): item is InboundAttachment => item !== null)
}

async function fetchOne(
  item: DeclaredMedia,
  index: number,
  auth: { accountSid: string; authToken: string },
): Promise<InboundAttachment | null> {
  let url: URL
  try {
    url = new URL(item.url)
  } catch {
    console.error('[sms] inbound media URL was not a URL; dropping')
    return null
  }
  if (url.protocol !== 'https:' || !TWILIO_HOST.test(url.hostname)) {
    console.error(`[sms] refusing to fetch inbound media from ${url.host}`)
    return null
  }

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      console.error(`[sms] Twilio returned ${response.status} for inbound media`)
      return null
    }

    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      console.error(`[sms] inbound media is ${declaredLength} bytes; refusing before reading it`)
      return null
    }

    const content = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? item.contentType
    return { fileName: textedFileName(index, contentType), contentType, content }
  } catch (error) {
    // Swallowed on purpose. The message itself is filed by the caller
    // whatever happens here, and throwing would hand Twilio a 500, which
    // retries, which duplicates a text we have already recorded.
    console.error('[sms] could not fetch inbound media', error)
    return null
  }
}

/// Twilio sends no filename, so one is made. `texted-` rather than the media
/// SID because `Document.fileName` is what staff read on the screen, and how
/// it arrived is more use to them than an opaque `ME…` identifier.
/// `displayFileName` sanitises whatever this produces before it is stored.
function textedFileName(index: number, contentType: string): string {
  const subtype = contentType.split(';')[0]!.trim().split('/')[1] ?? 'bin'
  const extension = subtype.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  return `texted-${index + 1}.${extension}`
}
