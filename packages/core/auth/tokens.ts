import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Single-use tokens for tenant magic links, password resets and vendor
// work-order links (D-6). Two rules hold for all of them:
//
//   1. The database stores a SHA-256 of the token, never the token. A dump of
//      AuthToken yields nothing anyone can click.
//   2. Lookup is by hash, so verification is a single indexed equality rather
//      than a scan-and-compare - which is also what keeps it constant-time
//      with respect to the stored value.
//
// A plain SHA-256 is correct here and bcrypt/scrypt would be wrong: these are
// 256-bit random values, not user-chosen secrets, so there is no dictionary to
// slow down and no reason to pay a memory-hard cost on every link click.

/// 32 bytes of CSPRNG output, base64url encoded. Comfortably beyond brute
/// force, and short enough to survive an SMS without wrapping badly.
const TOKEN_BYTES = 32

export interface MintedToken {
  /// Goes in the URL. Never persisted, never logged.
  token: string
  /// Goes in the database.
  tokenHash: string
  expiresAt: Date
}

/// §6.1: "tenant/vendor magic links short-lived and single-use". These are the
/// short-lived half; `consumedAt` in the database is the single-use half.
export const TOKEN_TTL_MINUTES = {
  TENANT_MAGIC_LINK: 15,
  /// R-165: a guarantor's own sign-in link. Same fifteen minutes as a
  /// tenant's - it is the identical credential over a different subject
  /// type, and there is no reason for it to be more or less exposed.
  GUARANTOR_MAGIC_LINK: 15,
  STAFF_PASSWORD_RESET: 30,
  TENANT_PASSWORD_RESET: 30,
  /// Long enough to fetch a phone from another room, short enough that a
  /// stolen challenge is worthless by the time anyone notices it.
  STAFF_MFA_CHALLENGE: 5,
  /// Longer because a vendor may not look at their phone for hours, and an
  /// expired dispatch link means a phone call instead of a plumber. Still far
  /// short of the work order's own lifetime - R-025 reissues rather than
  /// stretching this.
  VENDOR_WORK_ORDER: 60 * 24 * 3,
  /// R-026: a request for a price, before anyone is assigned. Same three
  /// days as a dispatch link and for the same reason - a vendor pricing a
  /// job looks at it when they look at it. Multi-use like VENDOR_WORK_ORDER
  /// (D-16), but issued per (work order, vendor) rather than one per work
  /// order, because bids are several vendors holding live links at once.
  VENDOR_BID: 60 * 24 * 3,
  /// R-032c: the tenant's "was this actually fixed?" (MAINT-07).
  ///
  /// SEVEN DAYS, the longest in this table, and the reason is that the reply
  /// rate IS the feature. A tenant is asked once, on a day chosen by whenever
  /// the vendor happened to finish; they may be at work, asleep, or away for
  /// the weekend. Every hour this is shorter is a job closed on silence
  /// instead of on an answer.
  ///
  /// Safe to be this long because of what the token can DO: record one
  /// yes-or-no about one work order. It opens no portal, reads no document,
  /// and moves no money — the blast radius of a leaked one is a wrong answer
  /// to a maintenance question, which a PM can see and reopen.
  TENANT_VERIFY: 60 * 24 * 7,
  /// R-046: pay rent from the link in the reminder, without a login (PAY-01).
  ///
  /// THREE DAYS, and the number is a compromise between two real failures.
  /// Too short and the link is dead when somebody opens the text on payday
  /// rather than the evening it arrived - which is the whole point of
  /// sending it. Too long and a forwarded message, a shared phone or a
  /// backed-up SMS thread keeps a live payment surface open for weeks.
  ///
  /// SHORTER THAN TENANT_VERIFY's seven days on purpose, because this one
  /// can MOVE MONEY. The verify link's blast radius is a wrong answer to a
  /// maintenance question; this one shows a balance and takes a payment, so
  /// it gets the vendor links' three days rather than the verify link's
  /// seven.
  TENANT_PAY_LINK: 60 * 24 * 3,
  /// R-058: a prospect's identical pre-screening questions. FOURTEEN DAYS -
  /// longer than every other purpose here, because a prospect has no
  /// existing relationship pulling them back to check a link, unlike a
  /// tenant or a vendor already mid-job. Safe to be this long because of
  /// what it can do: answer five fixed questions about one listing. It
  /// opens no session, reads no document and moves no money - the same
  /// bounded blast radius TENANT_VERIFY's own comment argues from, stretched
  /// further because the person on the other end is a stranger who saw a
  /// listing once, not someone already inside a tenancy.
  PROSPECT_PRESCREEN: 60 * 24 * 14,
  /// R-059: one adult's own application - their form, their document
  /// uploads, their fee payment, scoped to their own Applicant.id.
  ///
  /// MULTI-USE until it expires, like VENDOR_WORK_ORDER/TENANT_VERIFY/
  /// TENANT_PAY_LINK: a household gathering pay stubs and ID scans across
  /// several sittings must not find the link dead partway through -
  /// "progress is saved" is the PRD's own line.
  ///
  /// FIVE DAYS - a deliberate middle point. TENANT_PAY_LINK's three days is
  /// short BECAUSE it only shows a balance and takes a payment;
  /// TENANT_VERIFY's seven is long BECAUSE it moves no money and opens no
  /// document. This purpose does both at once (uploads documents AND can
  /// pay a fee), arguing shorter than seven, while a real household needs
  /// more than three days to coordinate pay stubs and photo IDs for
  /// several adults.
  APPLICATION_LINK: 60 * 24 * 5,
  /// R-063: one signer's own review-and-sign link for a lease sent for
  /// e-signature. SEVEN DAYS, matching TENANT_VERIFY rather than
  /// APPLICATION_LINK's five or TENANT_PAY_LINK's three - see the schema's
  /// own comment on `AuthTokenPurpose.LEASE_SIGN` for why: opening this link
  /// moves no money by itself, since the deposit charge and rent
  /// subscription only fire once every signer on the envelope has signed.
  LEASE_SIGN: 60 * 24 * 7,
  /// R-064: a prospect's own self-serve showing booking, sent right after
  /// pre-screening. FOURTEEN DAYS, matching PROSPECT_PRESCREEN - the same
  /// stranger-with-no-existing-relationship reasoning, and the single
  /// ACTION it guards (booking one slot) is no more sensitive than
  /// answering five questions: no document, no money, a fixed slot grid.
  SHOWING_BOOKING: 60 * 24 * 14,
  /// R-094: the prospect's link to the door for a showing they have already
  /// booked.
  ///
  /// THREE DAYS, and it is deliberately NOT the fourteen its sibling gets.
  /// SHOWING_BOOKING's fourteen days are safe because the single action it
  /// guards is picking a slot on a grid; this one is opened by somebody who
  /// already has a slot, so it only has to survive from the confirmation to
  /// the viewing - and a booking made three weeks out gets its link when the
  /// reminder goes, not now.
  ///
  /// AND THE NUMBER BARELY MATTERS, which is the part worth writing down:
  /// this link cannot open a door. It shows a page that runs an identity
  /// check and, inside `ShowingAccess.validFrom`/`validTo` and nowhere else,
  /// displays a code. A leaked link outside that window shows a sentence
  /// saying the code is not live. The window is the control; this is the
  /// second lock, not the first.
  SHOWING_ACCESS: 60 * 24 * 3,
  /// R-097c: a staff member's own calendar subscription (NOTIF-06).
  ///
  /// A YEAR, WHICH IS AN ORDER OF MAGNITUDE LONGER THAN ANYTHING ELSE HERE,
  /// and the reason is what the token is FOR: a calendar app is subscribed
  /// once and polls for ever, so a link that expires is a calendar that
  /// silently stops updating - the worst failure available, because it looks
  /// exactly like a quiet week.
  ///
  /// Safe to be this long because of the blast radius, which is the argument
  /// TENANT_VERIFY's own comment makes and this one stretches further. It
  /// reads one thing: where and when somebody's staff are visiting
  /// properties they can already see. It moves no money, opens no session,
  /// reads no document, and carries no tenant's name or contact details.
  /// **And it is per person and re-issuable**, so a leaked one is revoked by
  /// pressing a button on an account page rather than by rotating anything
  /// anybody else depends on.
  CALENDAR_FEED: 60 * 24 * 365,
} as const

export type TokenPurpose = keyof typeof TOKEN_TTL_MINUTES

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * `ttlMinutes` overrides the purpose's default lifetime.
 *
 * Added for R-032d, where the right lifetime depends on the JOB rather than
 * on the token: an emergency link is used within hours and should not linger,
 * while routine work is booked a week out and a three-day link is dead before
 * the vendor arrives. The default stays in the table so a caller that does not
 * care cannot get it wrong, and the override is explicit so a caller that does
 * has to say what it is doing.
 */
export function mintToken(
  purpose: TokenPurpose,
  now = new Date(),
  ttlMinutes = TOKEN_TTL_MINUTES[purpose],
): MintedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
  }
}

export type TokenRejection =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'wrong_purpose'
  | 'wrong_subject'

/// The stored shape this module needs to make a decision. Kept structural so
/// core does not import Prisma's generated types.
export interface StoredToken {
  purpose: string
  subjectType: string
  subjectId: string
  expiresAt: Date
  consumedAt: Date | null
}

/**
 * Decides whether a stored token may be redeemed. Pure, so the whole decision
 * table is testable without a database - the caller does the lookup by hash
 * and the conditional "consume" update.
 *
 * Order matters: purpose and subject are checked before expiry so a token
 * being replayed against the wrong endpoint reports the real reason to the
 * audit log rather than a misleading "expired".
 */
export function checkToken(
  stored: StoredToken | null,
  expected: { purpose: TokenPurpose; subjectType?: string; subjectId?: string },
  now = new Date(),
): { ok: true } | { ok: false; reason: TokenRejection } {
  if (!stored) return { ok: false, reason: 'not_found' }
  if (stored.purpose !== expected.purpose) {
    return { ok: false, reason: 'wrong_purpose' }
  }
  if (expected.subjectType && stored.subjectType !== expected.subjectType) {
    return { ok: false, reason: 'wrong_subject' }
  }
  if (expected.subjectId && stored.subjectId !== expected.subjectId) {
    return { ok: false, reason: 'wrong_subject' }
  }
  if (stored.consumedAt !== null) return { ok: false, reason: 'already_used' }
  if (stored.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true }
}

/// Recovery codes for the case ROLE-05 does not mention but every MFA rollout
/// hits: the phone is gone. Generated once at enrolment, shown once, stored
/// only as hashes.
export function mintRecoveryCodes(count = 10): {
  codes: string[]
  hashes: string[]
} {
  const codes = Array.from({ length: count }, () =>
    // 10 hex chars, grouped, so it is readable off a piece of paper.
    randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'),
  )
  return { codes, hashes: codes.map(hashToken) }
}

/**
 * Constant-time membership test for a recovery code. Returns the matched hash
 * so the caller can remove exactly that one - a spent recovery code must not
 * work twice.
 */
export function matchRecoveryCode(
  code: string,
  storedHashes: readonly string[],
): string | null {
  const candidate = Buffer.from(hashToken(code.trim().toLowerCase()))
  let matched: string | null = null

  // Every element is compared even after a hit, so the time taken does not
  // reveal the position of the matching code.
  for (const stored of storedHashes) {
    const storedBuffer = Buffer.from(stored)
    if (
      storedBuffer.length === candidate.length &&
      timingSafeEqual(storedBuffer, candidate)
    ) {
      matched = stored
    }
  }

  return matched
}
