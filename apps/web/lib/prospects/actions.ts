'use server'

import { validateProspectInquiry } from '@rental/core/prospects'
import { RATE_LIMITS } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { consumeRateLimit, issueToken } from '@/lib/auth/store.ts'
import { notify } from '@/lib/notifications/send.ts'

// PUBLIC writes for Prospect (LEASE-07, R-058) - no session, same posture as
// startStaffSignIn()/magic-link request: rate-limited by IP rather than
// permission-gated, because the caller has no account by definition.
//
// DELIBERATELY SEPARATE from staff-actions.ts, which needs `audit()` (session-
// resolved). `audit()` lives in lib/audit/index.ts, which imports Auth.js -
// and Auth.js cannot load outside a request context, so anything importing
// index.ts breaks under Vitest even if the importing FILE also exports
// something that never calls it (apps/web/lib/audit/system.ts's own header
// documents the identical wall for the same reason). Keeping this file
// import-clean of index.ts is what makes it testable against a real
// database with no browser - see prospects.test.ts.

export interface InquiryFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

const GENERIC_RATE_LIMIT_ERROR = 'Too many attempts. Wait a few minutes and try again.'

async function clientIp(): Promise<string> {
  const headerList = await headers()
  // Vercel sets x-forwarded-for; the leftmost entry is the client. Same
  // extraction as lib/auth/actions.ts and lib/audit/index.ts - small enough
  // that this codebase already duplicates it rather than sharing it.
  const forwarded = headerList.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? 'unknown'
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): InquiryFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

/**
 * A visitor submits the inquiry form on a published listing (LEASE-07).
 *
 * `ListingLead` (R-057) already logged this as an anonymous visit the
 * moment the page loaded - this is the separate, deliberate write that
 * turns it into a named Prospect, only when real contact information is
 * actually given. See ListingLead's own schema comment for why the two are
 * not merged.
 */
export async function submitInquiry(
  listingId: string,
  _previous: InquiryFormState,
  formData: FormData,
): Promise<InquiryFormState> {
  const ip = await clientIp()
  const limit = await consumeRateLimit(`prospect-inquiry:${ip}`, RATE_LIMITS.prospectInquiry)
  if (!limit.allowed) return { error: GENERIC_RATE_LIMIT_ERROR }

  const listing = await prisma.listing.findFirst({
    where: { id: listingId, status: 'PUBLISHED' },
  })
  // Not PUBLISHED (or gone) reads the same as "does not exist" to an
  // anonymous caller everywhere else in this product (ROLE-01) - a form
  // posted against a stale or unpublished listing gets a plain refusal,
  // not confirmation the id was ever real.
  if (!listing) return { error: 'That listing is no longer available.' }

  const input = {
    listingId,
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
    message: str(formData, 'message') || null,
  }
  const violations = validateProspectInquiry(input)
  if (violations.length > 0) return violationsToState(violations)

  const source = str(formData, 'source') || 'direct'

  const prospect = await prisma.$transaction(async (tx) => {
    const created = await tx.prospect.create({
      data: {
        propertyId: listing.propertyId,
        listingId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        message: input.message,
        source,
      },
    })
    // SYSTEM, not audit() - this is a public form with no session at all,
    // not a signed-in actor whose session simply wasn't checked. audit()
    // resolves the actor from Auth.js and, finding none, would record
    // "SYSTEM / anonymous" anyway (see R-054's own note on the identical
    // trap in a different action) - going through auditAsSystem() directly
    // also means this action needs no Auth.js session to run at all, which
    // is what makes it testable against a real database without a browser.
    await auditAsSystem(
      'prospect-inquiry',
      {
        action: 'prospect.created',
        entityType: 'Prospect',
        entityId: created.id,
        propertyId: listing.propertyId,
        after: { listingId, source },
      },
      tx,
    )
    return created
  })

  // Outside the transaction - a provider call (even the simulated one)
  // never holds a database transaction open (see delist-sweep.ts's own
  // header for the same rule applied to syndication). The invite failing
  // must not undo the Prospect row; sendPrescreenInvite records its own
  // failure instead.
  await sendPrescreenInvite(prospect.id).catch((error) => {
    console.error(`[prospects] failed to send the pre-screen invite for ${prospect.id}`, error)
  })

  revalidatePath(`/listings/${listingId}`)
  return {
    notice:
      "Thanks - check your email or phone for a few quick questions, and we'll be in touch.",
  }
}

/**
 * Mints a single-use PROSPECT_PRESCREEN token and sends the identical
 * invite. The Prospect row survives even when this fails (a bad address, a
 * provider outage) - see the caller's own comment for why this runs
 * outside the write's transaction. Exported rather than kept private so a
 * later resend control has something to call; none exists yet (left
 * behind, below).
 */
export async function sendPrescreenInvite(prospectId: string): Promise<void> {
  const prospect = await prisma.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { property: true },
  })

  const issued = await issueToken('PROSPECT_PRESCREEN', {
    type: 'Prospect',
    id: prospect.id,
  })

  await notify({
    category: 'prospect_prescreening',
    templateKey: 'prospect.prescreen_invite',
    recipient: {
      type: 'PROSPECT',
      id: prospect.id,
      email: prospect.email,
      phone: prospect.phone,
    },
    context: {
      firstName: prospect.firstName,
      addressLine1: prospect.property.addressLine1,
      url: authUrl(`/prescreen/${issued.token}`),
    },
    propertyId: prospect.propertyId,
    // Idempotent per prospect - a resend deliberately reuses this key so a
    // double-click cannot fan out two invites for the same inquiry.
    idempotencyKey: `prospect-prescreen:${prospect.id}`,
  })

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: { preScreenSentAt: new Date() },
  })
}
