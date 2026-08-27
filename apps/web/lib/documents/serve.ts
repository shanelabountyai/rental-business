import 'server-only'

import { MissingStoredObjectError } from '@/lib/storage/adapter.ts'
import { storage } from '@/lib/storage/index.ts'

// Handing stored bytes to a browser (R-security-1).
//
// ==========================================================================
// FOUR ROUTES SERVE DOCUMENT BYTES AND ALL FOUR WROTE THE SAME RESPONSE BY
// HAND, WHICH IS HOW THEY ALL GOT IT WRONG THE SAME WAY.
//
// `/api/documents/[id]/file`, `/listings/[id]/photos/[documentId]`,
// `/sign/[token]/document` and `/vendor/[token]/documents/[documentId]` each
// did `Content-Type: document.contentType` with `Content-Disposition:
// inline`. `Document.contentType` is whatever the UPLOADER'S BROWSER
// declared - `file.type`, straight off a `<input type=file>` - and
// `validateDocument` only ever checked that it was non-empty.
//
// So an applicant holding an `apply/[token]` link - a stranger who answered
// a listing - could upload `payslip.svg` declaring `image/svg+xml`, and the
// letting agent opening it to read the payslip would render an attacker's
// SVG IN THIS APP'S OWN ORIGIN, with their session cookie attached. An SVG
// is not a picture, it is a document that may contain <script>. `text/html`
// is the same attack with less ceremony. There is no CSP on this app to fall
// back on, and `nosniff` was not set either.
//
// The same reaches here from a tenant's maintenance photo, a vendor's
// invoice and a tenant's insurance certificate: every one of those paths
// stores `file.type` unexamined.
//
// THE TELL THAT IT WAS AN OVERSIGHT AND NOT A DECISION: the inbound-EMAIL
// attachment path (R-097d, `inbound-attachments.ts`) has exactly the right
// allowlist, because that item was written knowing a stranger was on the
// other end. An applicant, a tenant and a vendor are strangers in precisely
// the same sense, and each of those items was written from inside its own
// seam without looking at that one.
//
// FIXED HERE, AT THE ONE PLACE BYTES MEET A BROWSER, rather than at the
// upload sites. Guarding the four uploads would leave the fifth - the one
// nobody has written yet - and refusing types at upload would reject real
// evidence somebody needs to keep (a .docx addendum, an odd camera format).
// A file this product will not RENDER can still be stored and downloaded;
// what it must never do is execute in our origin.
// ==========================================================================

/**
 * Types that may be rendered in this app's origin.
 *
 * The test is not "is it a document we like", it is CAN IT EXECUTE. Anything
 * off this list is still served - as a download, with a type no browser will
 * run - so nothing is lost but the preview.
 *
 * `image/svg+xml` is deliberately absent and must stay absent: it is the
 * whole reason this file exists. So is `text/html` and every `*+xml`.
 *
 * PDF IS ON THE LIST, and that is a considered exception rather than an
 * oversight: a PDF can carry JavaScript, but browsers run it in their own
 * sandboxed viewer rather than in the page's origin, and PDF is the format
 * this product's entire evidence trail is made of - leases, notices, the
 * eviction packet, the tax archive. Serving those as downloads would break
 * the thing the product is for, to close a hole the browser already closed.
 */
const RENDERABLE: ReadonlySet<string> = new Set([
  // Cannot execute, and the `nosniff` below is what keeps that true: without
  // it a browser may sniff a `text/plain` body that is really markup and run
  // it as HTML, which is the historic version of this exact bug. The two
  // lines are a pair - do not remove `nosniff` and leave this here.
  //
  // NOT `text/*`. `text/html` and `text/xml` are text too, and both execute.
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
])

/// `image/jpeg; charset=binary` is one type with a parameter, and a browser
/// sends whatever it likes. Compared on the bare type, lower-cased.
function bareType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase()
}

/**
 * A filename safe to put inside a header value.
 *
 * `Document.fileName` is `file.name` from the uploader's machine, so it can
 * contain quotes (which would end the parameter early) and, in principle,
 * CR/LF. Node refuses to send a header containing a newline, so the latter
 * is a 500 rather than a response-splitting bug - but a 500 on somebody
 * opening a lease is still a defect, and one regex removes the question.
 */
function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[\r\n"\\]/g, '').trim()
  return cleaned === '' ? 'document' : cleaned
}

/**
 * The response for a stored document's bytes.
 *
 * `Content-Length` is taken from the BYTES, never from `Document.sizeBytes`.
 * The two agree for every file this product wrote, but the header is a
 * promise about THIS response: if a stored object and its recorded size ever
 * disagree - a half-written upload, a storage backend swapped under D-14 - a
 * length taken from the row makes the response malformed and the client
 * aborts mid-download rather than showing anything. Found by a test whose
 * fixture recorded a size it did not have.
 */
export function documentResponse(
  bytes: Buffer,
  document: { contentType: string; fileName: string },
  /// Each caller's own, because they genuinely differ: a published listing
  /// photo is `public` and CDN-cacheable, while a vendor or signer link is a
  /// BEARER CREDENTIAL whose bytes must not outlive the token in a shared
  /// cache. Left to the caller rather than defaulted, so a new route has to
  /// decide rather than inherit somebody else's answer.
  options: { cacheControl?: string } = {},
): Response {
  const type = bareType(document.contentType)
  const renderable = RENDERABLE.has(type)

  return new Response(new Uint8Array(bytes), {
    headers: {
      ...(options.cacheControl ? { 'Cache-Control': options.cacheControl } : {}),
      // An unrenderable type is not merely dispositioned as an attachment,
      // it is RETYPED. `Content-Disposition: attachment` alone still lets a
      // browser that fetches the URL another way act on the declared type,
      // and `octet-stream` is the one answer no browser executes.
      'Content-Type': renderable ? type : 'application/octet-stream',
      'Content-Disposition': `${renderable ? 'inline' : 'attachment'}; filename="${safeFileName(
        document.fileName,
      )}"`,
      'Content-Length': String(bytes.byteLength),
      // A LAST FENCE ON THE UNTRUSTED PATH ONLY. Anything off the allowlist
      // is a type nobody vetted, so its response says "load nothing, run
      // nothing" - if a future edit ever let one render, it still could not
      // fetch, script or phone home. Deliberately NOT applied to the
      // renderable path: those types cannot execute anyway, and `sandbox` on
      // a PDF response risks the browser's own viewer for no gain.
      ...(renderable ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
      // Belt and braces for the renderable list itself: without this a
      // browser may sniff a mislabelled `image/png` that is really HTML and
      // run it anyway, which would hand back the hole the allowlist closes.
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * Fetch a stored document's bytes and answer with them - or 404 when the row
 * points at bytes that are not there.
 *
 * ==========================================================================
 * ALL FOUR BYTE-SERVING ROUTES AWAITED `storage.get` BARE, SO A MISSING FILE
 * WAS AN UNHANDLED THROW AND A 500.
 *
 * Found on Milestone 11's demo walk, on the one page in this product a
 * STRANGER sees: `/listings/[id]` rendered its three photos as three broken
 * images and logged three exceptions per view, because the demo seed had
 * written the bytes under a different working directory. The seed's bug; the
 * 500 is ours. Every other "you cannot have this" answer on these routes is
 * already a deliberate 404 - an unpublished listing, a deleted document, a
 * document belonging to another job - and "the bytes are gone" belongs with
 * them rather than reading to the caller as "this server is broken".
 *
 * HERE RATHER THAN AT THE FOUR CALL SITES, for the same reason this file
 * exists at all: four hand-written copies of the same response is how all
 * four got the content type wrong (D-137), and a fifth route nobody has
 * written yet inherits the fix instead of the hole. The bytes are fetched
 * here so there is no bare `storage.get` left in a route to copy.
 *
 * ONLY `MissingStoredObjectError`. A Blob outage or a permissions error is
 * still a 500, because answering 404 would tell a CDN to remember that a
 * published listing has no photos.
 * ==========================================================================
 */
export async function documentFileResponse(
  document: { storageKey: string; contentType: string; fileName: string },
  options: { cacheControl?: string } = {},
): Promise<Response> {
  let bytes: Buffer
  try {
    bytes = await storage.get(document.storageKey)
  } catch (error) {
    if (error instanceof MissingStoredObjectError) {
      return new Response('Not found', { status: 404 })
    }
    throw error
  }
  return documentResponse(bytes, document, options)
}
