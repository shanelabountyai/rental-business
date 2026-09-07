import 'server-only'

import { TOKEN_TTL_MINUTES, checkToken, hashToken, mintToken } from '@rental/core/auth'
import {
  type MaintenanceCategory,
  type MaintenanceRequestInput,
  appendClarification,
  detectHabitabilityLanguage,
  isMaintenanceCategory,
  reportedWords,
  suggestTicketPriority,
  validateMaintenanceRequest,
} from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { auditAsTenant } from '@/lib/audit/system.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The questions a texted-in request never got asked (MAINT-01, MAINT-02,
// R-177).
//
// ==========================================================================
// WHY THIS EXISTS. `applicableTroubleshootingSteps` is seven scripts with
// illustrations — the GFCI that lives in another room, the disposal's reset
// button — and a hard rule that a TRIED-or-DECLINED outcome is logged before
// dispatch is allowed. Its only consumers were the portal wizard and the
// validator behind it.
//
// `handleInboundSms` opens a ticket at `category: 'UNCATEGORIZED'` with no
// prompts, no script and no photo, and `logPhoneMaintenanceRequest` did the
// same for a call. R-021's own backlog row puts those two channels at
// roughly half of real requests — and they are the half carrying the tenant
// who does not use the portal and the 11pm text, which is exactly where a
// wrong dispatch costs a truck roll. So the deflection machinery was
// reachable only from the channel the fewest tenants use.
//
// The phone half is fixed where it lives (the form now runs the same script
// on screen for the PM to read aloud). This file is the SMS half.
// ==========================================================================
//
// A TOKEN-SCOPED PAGE, NOT A SESSION — the fourth use of the pattern D-45
// argues for at length, after the vendor link (D-6, D-16), the verify link
// (R-032c) and the pay link. The tenant this exists for is the one with a
// phone and no email; portal login is EMAIL-ONLY, so a link into
// `/portal/maintenance/...` would be the same dead end R-032c was built to
// remove. The token names one ticket and, in its metadata, one tenant. It
// opens no session, reads no document and moves no money.

const PURPOSE = 'TICKET_CLARIFY' as const

/// Structurally `SubmitMaintenanceRequestArgs`, declared here rather than
/// imported from `maintenance/actions.ts`: that module is `'use server'`, and
/// a type reaching through one is the shape that passes typecheck and vitest
/// and fails only in `npm run build` (CLAUDE.md, "a `'use server'` module may
/// export only async functions"). Both sides are `MaintenanceRequestInput`
/// plus the ids of whichever photo uploads had resolved by the time Send was
/// pressed.
export interface ClarificationArgs extends MaintenanceRequestInput {
  photoDocumentIds: readonly string[]
}

/// Statuses where answering still changes what happens next. Everything else
/// — CONVERTED (a work order exists, somebody is already being sent), MERGED,
/// CLOSED — is a job whose description has become a dispatch document, and
/// appending to it after the fact is worse than a dead link.
const CLARIFIABLE_STATUSES = ['NEW', 'TRIAGED', 'WAITING_ON_TENANT'] as const

export async function issueClarifyLink(
  subject: { ticketId: string; tenantId: string },
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const minted = mintToken(PURPOSE, now)

  await prisma.$transaction(async (tx) => {
    // One live link per ticket. A ticket only gets asked once today, but a
    // stale link failing as *expired* rather than quietly answering an older
    // question is the same call `issueVerifyLink` makes, for the same reason.
    await tx.authToken.updateMany({
      where: { purpose: PURPOSE, subjectId: subject.ticketId, consumedAt: null },
      data: { consumedAt: now },
    })
    await tx.authToken.create({
      data: {
        purpose: PURPOSE,
        tokenHash: minted.tokenHash,
        subjectType: 'Ticket',
        subjectId: subject.ticketId,
        expiresAt: minted.expiresAt,
        // The tenant is in the METADATA, not re-derived from the ticket at
        // use time: a ticket reassigned between issue and use must not
        // silently move who is entitled to answer it.
        metadata: { tenantId: subject.tenantId },
      },
    })
  })

  return { token: minted.token, expiresAt: minted.expiresAt }
}

export type ClarifyLinkResult =
  | {
      ok: true
      ticketId: string
      tenantId: string
      /// What they told us, in their own words — never the whole
      /// `description`, whose tail is written at staff (see `reportedWords`).
      reported: string
      propertyName: string
      unitName: string
      /// Set by a PM during triage. When it is already a real category, the
      /// tenant's own choice is recorded in the transcript but does not
      /// overwrite the human's decision.
      triagedCategory: MaintenanceCategory | null
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'answered' | 'in_progress' }

/**
 * Verifies a token from a URL and returns the request it authorizes.
 *
 * NON-CONSUMING, like the vendor link (D-16) and the verify link: the page
 * has to render before the tenant answers, and burning the token on the GET
 * would mean the POST that follows arrives unauthenticated. The burn happens
 * in `applyClarification` below, on the submit.
 */
export async function verifyClarifyLink(token: string): Promise<ClarifyLinkResult> {
  const stored = await prisma.authToken.findFirst({
    // The RAW token is never stored — only its SHA-256 — so a dump of
    // AuthToken yields nothing anyone can click.
    where: { purpose: PURPOSE, tokenHash: hashToken(token) },
  })
  // The EXPECTATION is passed, not just the clock: without the purpose check
  // a vendor link's raw token would authenticate here, since every purpose's
  // hashes live in one table.
  const check = checkToken(stored ?? null, { purpose: PURPOSE, subjectType: 'Ticket' })
  if (!check.ok) {
    if (check.reason === 'expired') return { ok: false, reason: 'expired' }
    // `already_used` is not an error here, it is the record: this token is
    // burned on submit, so it means the tenant has already answered.
    if (check.reason === 'already_used') return { ok: false, reason: 'answered' }
    return { ok: false, reason: 'invalid' }
  }

  const metadata = (stored!.metadata ?? {}) as { tenantId?: string }
  const tenantId = metadata.tenantId
  if (!tenantId) return { ok: false, reason: 'invalid' }

  const ticket = await prisma.ticket.findUnique({
    where: { id: stored!.subjectId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      category: true,
      description: true,
      property: { select: { name: true } },
      unit: { select: { name: true } },
      _count: { select: { workOrders: true } },
    },
  })
  if (!ticket) return { ok: false, reason: 'invalid' }

  // The token's tenant must still be the ticket's tenant. Belt and braces
  // against a ticket reassigned between issue and use.
  if (ticket.tenantId !== tenantId) return { ok: false, reason: 'invalid' }

  // TWO GATES, NOT ONE, and the work-order count is the load-bearing half.
  // A ticket can still read TRIAGED while a work order hangs off it, and
  // once somebody is being sent the answer cannot change what happens — the
  // description has become the sheet that person is working from.
  if (
    !(CLARIFIABLE_STATUSES as readonly string[]).includes(ticket.status) ||
    ticket._count.workOrders > 0
  ) {
    return { ok: false, reason: 'in_progress' }
  }

  return {
    ok: true,
    ticketId: ticket.id,
    tenantId,
    reported: reportedWords(ticket.description),
    propertyName: ticket.property.name,
    unitName: ticket.unit.name,
    triagedCategory:
      ticket.category !== 'UNCATEGORIZED' && isMaintenanceCategory(ticket.category)
        ? ticket.category
        : null,
  }
}

export type ApplyClarificationResult =
  | { ok: true; ticketId: string }
  | { error: string; fieldErrors?: Record<string, string> }

/**
 * Writes the answers onto the ticket the token names.
 *
 * RE-VERIFIES THE TOKEN rather than trusting the page that rendered the form
 * (D-45's rule, and the reason it is a rule: the page and the submit are two
 * requests, and only one of them was ever authorized).
 *
 * What it does NOT do is as deliberate as what it does:
 *
 *   - the description is APPENDED to, never replaced. An SMS ticket's
 *     description is the tenant's own words off the message they sent;
 *   - a category a PM set during triage is left alone. The tenant's choice
 *     lands in the transcript, where a human can read the disagreement,
 *     rather than silently overwriting a decision somebody made on purpose;
 *   - priority is only re-derived while `firstResponseAt` is null. Once a PM
 *     has triaged, `suggestTicketPriority`'s weak category-plus-habitability
 *     signal must not walk back over a deliberate call (R-023);
 *   - `habitabilityFlag` is only ever raised, never cleared. It starts a
 *     legally significant response clock (MAINT-02, RISK-05), and nothing a
 *     tenant answers later is grounds for stopping one.
 */
export async function applyClarification(
  token: string,
  args: ClarificationArgs,
  now = new Date(),
): Promise<ApplyClarificationResult> {
  const link = await verifyClarifyLink(token)
  if (!link.ok) {
    return { error: clarifyRejectionMessage(link.reason) }
  }

  if (!isMaintenanceCategory(args.category)) {
    return { error: 'Choose a category.' }
  }
  const violations = validateMaintenanceRequest(args)
  if (violations.length > 0) {
    return {
      error: 'A few things need an answer before this can be sent.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  const category = args.category

  const existing = await prisma.ticket.findUniqueOrThrow({
    where: { id: link.ticketId },
    select: {
      description: true,
      category: true,
      habitabilityFlag: true,
      firstResponseAt: true,
      propertyId: true,
    },
  })

  const description = appendClarification(existing.description, category, args)
  // Over the WHOLE description, not just the new half: a tenant whose text
  // said "there's mold" and whose answers say "under the sink" should have
  // both scanned, and the scan is cheap.
  const habitabilityFlag =
    existing.habitabilityFlag || detectHabitabilityLanguage(description)
  const triaged = existing.category !== 'UNCATEGORIZED'

  const burned = await prisma.$transaction(async (tx) => {
    // THE BURN IS THE CONCURRENCY GUARD, and it goes first. Two taps of Send
    // on a slow connection are two requests that both passed
    // `verifyClarifyLink`; only one can win this conditional update, and the
    // loser appends nothing.
    const consumed = await tx.authToken.updateMany({
      where: { purpose: PURPOSE, tokenHash: hashToken(token), consumedAt: null },
      data: { consumedAt: now },
    })
    if (consumed.count === 0) return false

    await tx.ticket.update({
      where: { id: link.ticketId },
      data: {
        description,
        category: triaged ? undefined : category,
        priority: existing.firstResponseAt
          ? undefined
          : suggestTicketPriority({ category, habitabilityFlag }),
        habitabilityFlag,
        // The tenant is the authority on both of these, always. The SMS path
        // could only default them to false, which is indistinguishable from
        // a tenant who said "no, come when I am home".
        entryPermission: args.entryPermission === true,
        petWarning: args.petWarning === true,
      },
    })

    // auditAsTenant, not audit(): there is no session here by construction,
    // and `audit()` would record the one person whose answer this is as
    // SYSTEM / anonymous (the bug R-032c found the hard way).
    await auditAsTenant(
      link.tenantId,
      {
        action: 'ticket.clarified',
        entityType: 'Ticket',
        entityId: link.ticketId,
        propertyId: existing.propertyId,
        before: { category: existing.category },
        after: { category: triaged ? existing.category : category, habitabilityFlag },
      },
      tx,
    )
    return true
  })

  if (!burned) return { error: clarifyRejectionMessage('answered') }

  // AFTER the transaction, like `submitMaintenanceRequest`'s own photo loop:
  // a photo that fails to attach must not roll back the answers, which are
  // the part that changes what gets dispatched.
  //
  // The `ticketId: null` and `tenantId` conditions are what stop a guessed
  // document id attaching somebody else's photo — the same two checks
  // `attachMaintenancePhotoInternal` makes, written here rather than
  // imported because that one lives in a `'use server'` module and exporting
  // it would publish a tenant-id-taking endpoint to the browser.
  for (const documentId of args.photoDocumentIds) {
    await prisma.document.updateMany({
      where: { id: documentId, tenantId: link.tenantId, ticketId: null },
      data: { ticketId: link.ticketId },
    })
  }

  return { ok: true, ticketId: link.ticketId }
}

export const CLARIFY_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES[PURPOSE]

/**
 * What a dead link says, in the tenant's words.
 *
 * A sync function, and therefore here rather than beside the action: a
 * `'use server'` module may export only async functions.
 *
 * Every branch names what to do next. A dead end that says only "invalid
 * link" sends somebody to the phone, which is the outcome this item exists
 * to remove.
 */
export function clarifyRejectionMessage(
  reason: Extract<ClarifyLinkResult, { ok: false }>['reason'],
): string {
  switch (reason) {
    case 'expired':
      return 'This link has expired. Your request is still with us — text us again if anything has changed.'
    case 'answered':
      return 'Thanks — we have your answers. There is nothing else you need to do.'
    case 'in_progress':
      return 'We are already on this one, so there is nothing left to answer. Text us if something has changed.'
    default:
      return 'This link is not working. Text us and we will pick it up from there.'
  }
}

/**
 * Sends the one message the whole item turns on (MAINT-01, MAINT-02).
 *
 * Through `notify()`, not straight at the adapter: the engine is where
 * preferences, quiet hours and TCPA consent live, and a tenant who has muted
 * this has told the PM to pick up the phone instead. The one documented
 * exception to that rule is a carrier keyword reply, which addresses a NUMBER
 * rather than a person — this addresses a tenant we have just identified by
 * name.
 *
 * WHICH MEANS IT CAN BE CORRECTLY SILENT, and that is not a bug to route
 * around. TCPA consent (R-051b) is a real gate: a tenant with no
 * `TenantConsent` row for SMS gets this in the portal only, however sensibly
 * "they texted us first" reads as agreement. That is a legal judgment for
 * the owner, not one to make quietly inside a send helper — recorded in
 * PROGRESS rather than resolved here.
 *
 * NEVER THROWS INTO ITS CALLER. `handleInboundSms` runs inside Twilio's
 * webhook: an exception here becomes a 500, which Twilio retries, which
 * duplicates a message already recorded. The ticket exists whether or not
 * this message goes out, and losing the ticket to protect the invitation
 * would be the wrong way round.
 */
export async function inviteToClarify(ticketId: string): Promise<void> {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        propertyId: true,
        description: true,
        property: { select: { addressLine1: true } },
        tenant: { select: { id: true, email: true, phone: true, firstName: true } },
      },
    })
    const tenant = ticket?.tenant
    if (!ticket || !tenant) return

    // Minted BEFORE the send, and the send is skipped if minting fails: an
    // invitation carrying a broken link is worse than none, because the
    // tenant taps it, hits a dead end, and stops trusting the next one.
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId: tenant.id })

    const outcomes = await notify({
      // `maintenance_clarify`, not `maintenance_update`: the latter defaults
      // OFF on SMS, which would deliver this to the portal alone - the one
      // place the phone-only tenant this exists for never looks.
      category: 'maintenance_clarify',
      templateKey: 'ticket.clarify_request',
      recipient: {
        type: 'TENANT',
        id: tenant.id,
        email: tenant.email,
        phone: tenant.phone,
      },
      context: {
        tenantName: tenant.firstName,
        requestSummary: reportedWords(ticket.description).slice(0, 120),
        addressLine1: ticket.property.addressLine1,
        // ABSOLUTE, from AUTH_URL. A relative path in an SMS is not a link,
        // it is a string a tenant cannot tap — on the one message whose
        // entire value is the tap.
        url: authUrl(`/clarify/${token}`),
      },
      propertyId: ticket.propertyId,
      // One invitation per ticket, ever. A tenant who sends three texts about
      // the same leak threads them onto one ticket (`decideSmsIntake`), and
      // three copies of the same link is how a helpful reply becomes spam.
      idempotencyKey: `ticket-clarify:${ticket.id}`,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
    }
  } catch (error) {
    console.error(`[clarify] could not invite the tenant on ${ticketId}`, error)
  }
}
