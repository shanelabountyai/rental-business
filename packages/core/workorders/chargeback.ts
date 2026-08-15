import { formatCents } from '../money/index.ts'

// Billing a tenant for a repair they caused (MAINT-07, R-031).
//
// ==========================================================================
// THE FIRST MAINTENANCE OUTCOME THAT WRITES TO THE LEDGER, which is why the
// backlog puts it here rather than in the move-out milestone. A move-out
// deduction (R-071) comes out of money already held; this takes money from
// somebody still living there, mid-lease, and the only thing standing between
// it and a fair-housing or retaliation complaint is that every number is
// defensible and every step is on the record.
//
// TWO RULES DO MOST OF THE WORK HERE.
//
//   1. You may bill LESS than the repair cost. You may never bill MORE.
//      Partial fault, betterment (a 12-year-old carpet replaced with a new
//      one is not a 100% tenant cost), a goodwill split - all of them reduce
//      the number. Nothing justifies raising it above what was actually
//      spent, because at that point it is not a chargeback, it is a penalty,
//      and a penalty needs a basis in the lease and the statute that this
//      flow does not establish.
//
//   2. Nothing is inferred. The job must be CLOSED, somebody must have marked
//      it tenant-caused, and somebody must have typed an amount. `unknown`
//      does not become `tenant_caused` because a repair looked avoidable, and
//      the close action's own comment says so where it writes the flag.
// ==========================================================================

export interface ChargebackFacts {
  /// Terminal status only. Billing for a job still in progress is billing for
  /// work that might yet be redone under warranty or reopened by the tenant.
  status: string
  /// Set at close from the three-way cause radio. `unknown` and `normal_wear`
  /// both leave it false, and false means no.
  tenantCaused: boolean
  /// What the repair actually cost - `jobCostCents(facts)`, the same number
  /// the close panel showed. The ceiling on what may be billed.
  jobCostCents: number
  /// The tenancy to bill. Null for a job with no ticket and no active lease
  /// on the unit, which is a real and normal state - a PM-raised job on a
  /// vacant unit has nobody to charge.
  leaseId: string | null
  /// An existing chargeback on this job, if one was already posted.
  existingChargeId: string | null
  /// What somebody typed into the amount field, in cents.
  requestedCents: number
}

export type ChargebackRefusal =
  | 'not_closed'
  | 'not_tenant_caused'
  | 'no_cost'
  | 'no_tenancy'
  | 'already_charged'
  | 'zero_requested'
  | 'exceeds_job_cost'

export interface ChargebackDecision {
  allowed: boolean
  refusal?: ChargebackRefusal
  /// Set when allowed, so a caller never re-derives the amount it is about to
  /// charge from a different expression than the one that was validated.
  amountCents?: number
  /// True when the tenant is being billed less than the job cost. Not a
  /// refusal - it is the common case, and the notice says so explicitly so a
  /// tenant can see they were not billed the whole thing.
  partial?: boolean
}

/**
 * Whether this job may be billed to the tenant, and for how much.
 *
 * Ordered so the answer a person most needs comes first. "This job was closed
 * as normal wear" tells somebody they are on the wrong screen; "you cannot
 * bill more than it cost" tells them to change one number. Leading with the
 * second when the first is also true would send them to fix an amount on a
 * job that can never be billed at all.
 */
export function chargebackDecision(facts: ChargebackFacts): ChargebackDecision {
  if (facts.status !== 'CLOSED') return { allowed: false, refusal: 'not_closed' }
  if (!facts.tenantCaused) return { allowed: false, refusal: 'not_tenant_caused' }
  if (facts.existingChargeId) return { allowed: false, refusal: 'already_charged' }
  if (!facts.leaseId) return { allowed: false, refusal: 'no_tenancy' }
  // A job that cost nothing has nothing to apportion. Checked before the
  // amount, so "$0 job" is not reported as "you asked for more than it cost",
  // which is true but useless.
  if (facts.jobCostCents <= 0) return { allowed: false, refusal: 'no_cost' }

  if (!Number.isInteger(facts.requestedCents) || facts.requestedCents <= 0) {
    return { allowed: false, refusal: 'zero_requested' }
  }
  if (facts.requestedCents > facts.jobCostCents) {
    return { allowed: false, refusal: 'exceeds_job_cost' }
  }

  return {
    allowed: true,
    amountCents: facts.requestedCents,
    partial: facts.requestedCents < facts.jobCostCents,
  }
}

export interface ChargebackNoticeContext {
  tenantName: string
  addressLine1: string
  unitName: string
  /// What the job was, in the words already on the work order.
  jobSummary: string
  /// Property-local calendar day the work was completed (D-3). A
  /// `BusinessDate` string - no timezone may touch it on the way in.
  completedOn: string
  jobCostCents: number
  amountCents: number
  /// Why this is the tenant's cost rather than ours. Typed by the person
  /// posting it and reproduced verbatim - a chargeback whose reason was
  /// generated by us is not a reason, it is a template.
  reason: string
  /// How many photos and invoices are attached to the job, so the notice can
  /// say what the tenant is entitled to see.
  evidenceCount: number
}

/**
 * The notice served with the charge.
 *
 * A DRAFT, and its last line says so, like every legal artifact this product
 * generates (D-4). Not reviewed by counsel and not legal advice.
 *
 * WHAT IT HAS TO CONTAIN is not a style question. A tenant billed for damage
 * needs to be able to answer four things without calling: what was repaired,
 * what it cost, what portion of that they are being asked to pay and why, and
 * how to disagree. A notice missing the fourth is the one that becomes a
 * complaint, because the only remaining way to disagree is to stop paying.
 *
 * THE ARITHMETIC IS ON THE NOTICE when the amount is less than the cost. It
 * is the single most useful line in the whole message - a tenant who can see
 * they were billed $150 of a $412 repair reads it as a decision somebody made
 * in their favour, and one who is shown only "$150" reads it as a number we
 * invented.
 */
export function chargebackNoticeText(context: ChargebackNoticeContext): string {
  const partial = context.amountCents < context.jobCostCents

  return [
    'Notice of repair charge',
    '',
    `Dear ${context.tenantName},`,
    '',
    `A repair at ${context.addressLine1}${
      context.unitName ? ` (${context.unitName})` : ''
    } was completed on ${context.completedOn}:`,
    '',
    context.jobSummary,
    '',
    `This repair was recorded as tenant-caused rather than normal wear, for the following reason:`,
    '',
    context.reason,
    '',
    partial
      ? `The repair cost ${formatCents(context.jobCostCents)}. You are being charged ${formatCents(
          context.amountCents,
        )} of that amount — not the full cost.`
      : `The repair cost ${formatCents(context.jobCostCents)}, and that is the amount being charged to your account.`,
    '',
    context.evidenceCount > 0
      ? `${context.evidenceCount} ${
          context.evidenceCount === 1 ? 'document or photo is' : 'documents and photos are'
        } attached to this repair in your portal, including the contractor's invoice where one was provided. You are entitled to see all of it.`
      : 'You are entitled to see the contractor invoice and any photos of this repair; contact us and we will provide them.',
    '',
    'This charge will appear on your account and in your payment history.',
    '',
    'If you disagree with this charge, tell us in writing before it becomes due and we will review it with you. Disputing a repair charge is not a failure to pay rent, and we will not treat it as one.',
    '',
    '— This notice is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  ].join('\n')
}
