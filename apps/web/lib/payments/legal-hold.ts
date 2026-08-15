import 'server-only'

import { holdIsActive } from '@rental/core/payments'
import type { PaymentHold } from '@rental/core/payments'
import type { AuditDb, AuditInput } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { syncLeasePayer } from '@/lib/billing/lifecycle.ts'
import { revokePayLinks } from '@/lib/portal/pay-link.ts'

/// The audit write, injected rather than imported.
///
/// `lib/audit/index.ts` resolves the actor from the Auth.js session, which
/// cannot load outside a request context — so importing it here would make
/// this module untestable under Vitest, and the one test the backlog demands
/// by name is a test OF this module. Same injection R-032c's
/// `recordVerification` uses, for the same reason.
export type AuditWriter = (input: Omit<AuditInput, 'actor'>, db?: AuditDb) => Promise<void>

// Placing and lifting a legal-action payment hold (PAY-12, R-047).
//
// ==========================================================================
// THE DEFECT THIS ITEM EXISTS TO PREVENT, IN THE BACKLOG'S OWN WORDS: "an
// autopay charge that fires the morning after a notice is served is a defect
// with legal consequences".
//
// So a hold is pushed to Stripe SYNCHRONOUSLY, and this refuses to report a
// hold as in force unless Stripe accepted it. The nightly reconciliation
// sweep would eventually pause the subscription — but "eventually" is the
// next morning, and the next morning is when the charge fires.
//
// FAILING LOUDLY IS THE WHOLE POINT. If the billing provider is unreachable,
// the operator must learn that the hold is NOT in force, because the action
// they will take next — serving a notice — depends on it. A hold recorded
// optimistically and retried later would show "held" on a screen while
// Stripe charged the tenant in the morning, which is precisely the failure
// the row names. Every other write in this product treats a provider outage
// as an operational condition to swallow; this one does not, and it is the
// only place that judgement goes the other way.
// ==========================================================================
//
// THREE THINGS CLOSE TOGETHER OR THE HOLD LEAKS:
//
//   1. Stripe stops collecting (`collectionPaused` → `mark_uncollectible`).
//   2. The payment UI refuses (the same flag, read by the pay screen, the
//      pay action and the pay-link page).
//   3. Live pay-now links are revoked (R-046), because a token minted before
//      the hold is a payment surface sitting in somebody's text messages.
//
// The third is the one that is easy to miss: it does not exist on any screen,
// and nothing would have failed without it until a tenant paid from a
// three-day-old reminder after a notice was served.

export interface HoldChange extends PaymentHold {
  reason: string
}

export type HoldResult =
  | { ok: true; linksRevoked: number; stripePaused: boolean }
  | { ok: false; error: string }

/**
 * Applies (or lifts) a payment hold, and proves it reached Stripe.
 *
 * `reason` is required whenever any switch is on — see the audit action's
 * own note. Lifting a hold needs one too: "why did we start taking their
 * money again" is as much a part of the record as why we stopped.
 */
export async function applyPaymentHold(
  leasePayerId: string,
  change: HoldChange,
  actorStaffId: string,
  writeAudit: AuditWriter,
): Promise<HoldResult> {
  const payer = await prisma.leasePayer.findUnique({
    where: { id: leasePayerId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      active: true,
      collectionPaused: true,
      blockPartialPayments: true,
      certifiedFundsOnly: true,
      stripeSubscriptionId: true,
    },
  })
  if (!payer || !payer.active) return { ok: false, error: 'That payer no longer exists.' }

  if (change.reason.trim().length < 10) {
    return {
      ok: false,
      error:
        'Say why. This is the record an eviction is argued from, and a hold nobody can explain is worse than no hold.',
    }
  }

  const before = {
    blockOnline: payer.collectionPaused,
    blockPartial: payer.blockPartialPayments,
    certifiedFundsOnly: payer.certifiedFundsOnly,
  }
  const active = holdIsActive(change)

  // WRITTEN FIRST, so the payment UI and the pay-link page refuse from this
  // moment on. Stripe is reconciled immediately below; if that fails, the
  // caller is told the hold is not fully in force — but the half we control
  // is already closed, which is the safe direction to be wrong in.
  await prisma.leasePayer.update({
    where: { id: payer.id },
    data: {
      collectionPaused: change.blockOnline,
      blockPartialPayments: change.blockPartial,
      certifiedFundsOnly: change.certifiedFundsOnly,
      paymentHoldReason: active ? change.reason.trim() : null,
      paymentHoldSetAt: active ? new Date() : null,
      paymentHoldSetByStaffId: active ? actorStaffId : null,
    },
  })

  // Every live pay-now link dies with the hold (R-046). A token minted
  // before the notice is a payment surface sitting in a text message, and
  // nothing on any screen would have shown it.
  const linksRevoked = change.blockOnline ? await revokePayLinks(payer.id) : 0

  // AND STRIPE, NOW. `syncLeasePayer` reads our row, compares it against the
  // subscription and pauses or resumes accordingly — the same reconciliation
  // the nightly sweep runs, called inline because the next morning is too
  // late.
  const sync = await syncLeasePayer(payer.id)
  const stripePaused = sync.outcome !== 'failed'

  await writeAudit({
    action: 'payment.hold_changed',
    entityType: 'LeasePayer',
    entityId: payer.id,
    propertyId: payer.propertyId,
    before,
    after: {
      blockOnline: change.blockOnline,
      blockPartial: change.blockPartial,
      certifiedFundsOnly: change.certifiedFundsOnly,
      // RECORDED EVEN WHEN IT FAILED, and that is the point of putting it on
      // the audit row: "we believed this tenancy was held" and "Stripe was
      // actually told" are different facts, and a dispute needs both.
      stripeOutcome: sync.outcome,
      linksRevoked,
    },
    reason: change.reason.trim(),
  }).catch((error) => {
    console.error(`[legal-hold] failed to audit hold on ${payer.id}`, error)
  })

  if (!stripePaused) {
    return {
      ok: false,
      error:
        'The hold is set here, but the payment provider did not confirm it — an automatic charge could still go through. Retry from the Billing Runs screen before serving anything.',
    }
  }

  return { ok: true, linksRevoked, stripePaused }
}

/**
 * Records that a hold turned somebody away (PAY-12).
 *
 * "The attempt is logged to the case file" is the acceptance criterion, and
 * the reason it matters runs the other way from how it first reads: an
 * eviction turning on "they never tried to pay" has to be arguable against a
 * record of every time they did. This is that record, and it is written from
 * the tenant's side of the refusal rather than the operator's.
 *
 * Never throws into the payment path. A refusal that failed to log is still
 * a refusal, and losing the payment screen's own error to an audit failure
 * would be the tail wagging the dog.
 */
export async function recordHoldRefusal(
  args: {
    leasePayerId: string
    propertyId: string
    refusal: string
    attemptedCents: number
    owedCents: number
  },
  writeAudit: AuditWriter,
): Promise<void> {
  await writeAudit({
    action: 'payment.hold_refused',
    entityType: 'LeasePayer',
    entityId: args.leasePayerId,
    propertyId: args.propertyId,
    after: {
      refusal: args.refusal,
      // WHAT THEY TRIED TO PAY, which is the number that matters later: a
      // tenant who repeatedly offered the full balance and was refused has a
      // materially different case from one who offered $20 once.
      attemptedCents: args.attemptedCents,
      owedCents: args.owedCents,
    },
  }).catch((error) => {
    console.error(`[legal-hold] failed to log a refused attempt on ${args.leasePayerId}`, error)
  })
}

/// The hold as core wants it, for a payer row already in hand.
export function holdFrom(payer: {
  collectionPaused: boolean
  blockPartialPayments: boolean
  certifiedFundsOnly: boolean
}): PaymentHold {
  return {
    blockOnline: payer.collectionPaused,
    blockPartial: payer.blockPartialPayments,
    certifiedFundsOnly: payer.certifiedFundsOnly,
  }
}
