// Insurance claims (RISK-07, R-089).
//
// ==========================================================================
// THE REPAIR COST IS NEVER TYPED ON A CLAIM. IT IS SUMMED FROM THE JOBS.
//
// RISK-07 asks for "payout vs. actual repair cost", and the tempting build is
// a `repairCostCents` column on the claim that somebody fills in from the
// adjuster's worksheet. D-19 already settled why not: the cost of a job is
// typed ONCE, on the work order, and every downstream reader computes from
// that row. The backlog calls the work-order → invoice → P&L chain "the
// specific place owners abandon software", and it breaks the same way every
// time — somebody types a total a second time somewhere else, the two copies
// drift, and neither can be trusted again.
//
// So a claim LINKS work orders (`WorkOrder.insuranceClaimId`) and
// `claimPosition` sums them with the same rule the tax export uses: the
// invoice where there is one, labour plus materials otherwise. A claim whose
// repair cost disagrees with the maintenance spend is then impossible rather
// than merely unlikely.
// ==========================================================================
//
// WHAT THIS FILE DOES NOT DO is decide whether a loss is covered, whether an
// adjuster's offer is fair, or how proceeds are taxed. The first two are the
// carrier's and the owner's; the third is an accountant's, and
// packages/core/tax refuses it explicitly rather than netting anything
// silently.

import type { BusinessDate } from '../scheduling/local-time.ts'
import { jobCostCents } from '../workorders/verify.ts'

/// The shape `jobCostCents` reads. Named here so a caller assembling claim
/// facts does not have to reach into the work-order module for a type.
export interface JobCost {
  invoiceCents: number | null
  actualLaborCents: number | null
  actualMaterialsCents: number | null
}

// ---------------------------------------------------------------------------
// The loss
// ---------------------------------------------------------------------------

export const CAUSES_OF_LOSS = [
  'WATER',
  'FIRE',
  'WIND_HAIL',
  'THEFT_VANDALISM',
  'LIABILITY',
  'OTHER',
] as const

export type CauseOfLoss = (typeof CAUSES_OF_LOSS)[number]

export function isCauseOfLoss(value: string): value is CauseOfLoss {
  return (CAUSES_OF_LOSS as readonly string[]).includes(value)
}

export const CAUSE_OF_LOSS_LABELS: Record<CauseOfLoss, string> = {
  WATER: 'Water — burst pipe, supply line, roof or appliance leak',
  FIRE: 'Fire or smoke',
  WIND_HAIL: 'Wind or hail',
  THEFT_VANDALISM: 'Theft or vandalism',
  LIABILITY: 'Liability — injury or damage to somebody else',
  OTHER: 'Something else',
}

// ---------------------------------------------------------------------------
// The mitigation clock — the number a water claim is argued about
// ---------------------------------------------------------------------------

/**
 * How long a water loss may sit before the argument changes.
 *
 * ==========================================================================
 * A HOUSE RULE, NOT A POLICY TERM, AND IT SAYS SO EVERYWHERE IT SURFACES.
 *
 * Every property policy carries a duty to mitigate, and none of them states
 * an hour count — what they say is "reasonable" and "prompt". What actually
 * decides a disputed water claim is whether the owner can show they moved
 * fast, and the industry convention the restoration trade works to is that
 * mould becomes arguable somewhere around 24–48 hours. So this is a nag with
 * a number, in the same spirit as R-087's three-attempts evidence bar: no
 * statute says it, and what a loss adjuster looks at is whether anybody
 * seriously tried.
 *
 * It is deliberately NOT a `JurisdictionRule`. This is not law at all — it is
 * a contract term interpreted by an adjuster, and D-4 governs statutory
 * numbers.
 * ==========================================================================
 */
export const WATER_MITIGATION_TARGET_HOURS = 24

export interface MitigationClock {
  /// Null when nothing has been recorded as started yet.
  hoursToMitigation: number | null
  /// Hours elapsed since the incident, whether or not anything has started.
  hoursElapsed: number
  started: boolean
  /// True only for a water loss past the target with nothing started.
  urgent: boolean
}

export function mitigationClock(
  incidentAt: Date,
  mitigationStartedAt: Date | null,
  cause: CauseOfLoss,
  now: Date,
): MitigationClock {
  const hours = (to: Date) => Math.max(0, (to.getTime() - incidentAt.getTime()) / 3_600_000)
  const hoursElapsed = hours(now)
  if (mitigationStartedAt) {
    return {
      hoursToMitigation: hours(mitigationStartedAt),
      hoursElapsed,
      started: true,
      urgent: false,
    }
  }
  return {
    hoursToMitigation: null,
    hoursElapsed,
    started: false,
    urgent: cause === 'WATER' && hoursElapsed > WATER_MITIGATION_TARGET_HOURS,
  }
}

export function mitigationSummary(clock: MitigationClock, cause: CauseOfLoss): string {
  const round = (n: number) => Math.round(n * 10) / 10
  if (clock.started) {
    const hours = round(clock.hoursToMitigation!)
    return `Mitigation started ${hours} hour${hours === 1 ? '' : 's'} after the loss. This is the number a disputed claim turns on — record what was done and photograph it.`
  }
  if (clock.urgent) {
    return `Nothing recorded as started, ${round(clock.hoursElapsed)} hours after a water loss. Past about ${WATER_MITIGATION_TARGET_HOURS} hours a carrier starts arguing that the damage is the delay's rather than the leak's. That threshold is a trade convention, not a policy term — but the delay is what gets quoted back.`
  }
  return `Nothing recorded as started, ${round(clock.hoursElapsed)} hours after the loss. Drying, boarding and making safe all count, and all of it needs photographs.`
}

// ---------------------------------------------------------------------------
// Loss of rents
// ---------------------------------------------------------------------------

export type RentSource =
  /// The rent the tenancy was actually paying — the best evidence there is.
  | 'lease'
  /// The unit's asking rent, used when the tenancy had already ended.
  | 'unit_market'

export interface LossOfRents {
  days: number
  amountCents: number
  source: RentSource
  monthlyRentCents: number
}

export const RENT_SOURCE_LABELS: Record<RentSource, string> = {
  lease: 'the rent this tenancy was actually paying',
  unit_market: 'the unit’s asking rent — the tenancy had already ended, so no contract rent applies',
}

/**
 * What the downtime was worth, and on whose number.
 *
 * ==========================================================================
 * THE SOURCE IS PART OF THE ANSWER, NOT AN IMPLEMENTATION DETAIL.
 *
 * An adjuster's first question about a loss-of-rents figure is where the rent
 * came from. A contract rent under a live lease is evidence; an asking rent on
 * an empty unit is an assertion, and one the carrier will discount. Returning
 * which one was used — and rendering it in the claim file — is the difference
 * between a number somebody can defend and a number somebody has to explain.
 *
 * The rent itself is never re-typed onto the claim, for D-19's reason: it is
 * on the lease, or on the unit, and a third copy would drift from both.
 * ==========================================================================
 *
 * Inclusive of both ends: a unit down on the 1st and back on the 1st was down
 * for one day, not zero.
 */
export function lossOfRents(
  monthlyRentCents: number,
  source: RentSource,
  from: BusinessDate,
  to: BusinessDate,
): LossOfRents {
  const days = Math.max(0, daysBetween(from, to) + 1)
  // A thirtieth of a month, the convention every carrier and every proration
  // in this product already uses. Not calendar-exact, and deliberately: a
  // February loss must not be worth more per day than a July one.
  const daily = Math.round(monthlyRentCents / 30)
  return { days, amountCents: daily * days, source, monthlyRentCents }
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const ms = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()
  return Math.round(ms / 86_400_000)
}

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

/**
 * What a payment was FOR, recorded when the cheque arrives.
 *
 * ==========================================================================
 * THIS SPLIT EXISTS BECAUSE THE TWO HALVES ARE TAXED DIFFERENTLY.
 *
 * Loss-of-rents proceeds replace rent, and rent is income. Proceeds for
 * physical damage are not income in the ordinary case — they bear on basis
 * and on whether the repair was deducted — and treating the two the same is
 * the single commonest way an owner's return goes wrong after a claim.
 *
 * Which half a payment belongs to is knowable exactly once: when the cheque
 * and its accompanying letter are in front of somebody, in March. It is not
 * recoverable in the following January from a bank line reading "CLAIM
 * SETTLEMENT". So it is a required column, not a derived one.
 *
 * What this file does NOT do is decide the treatment. packages/core/tax maps
 * the loss-of-rents half to income and refuses the rest into a counted
 * exception with the reasoning attached.
 * ==========================================================================
 */
export const PAYMENT_CATEGORIES = ['REPAIR', 'LOSS_OF_RENTS', 'CONTENTS', 'OTHER'] as const
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number]

export function isPaymentCategory(value: string): value is PaymentCategory {
  return (PAYMENT_CATEGORIES as readonly string[]).includes(value)
}

export const PAYMENT_CATEGORY_LABELS: Record<PaymentCategory, string> = {
  REPAIR: 'Repair or replacement of the building',
  LOSS_OF_RENTS: 'Loss of rents',
  CONTENTS: 'Contents — appliances, furnishings',
  OTHER: 'Something else',
}

/**
 * The repair cost is `jobCostCents` summed over the linked jobs — R-032e's
 * function, imported rather than re-expressed.
 *
 * There is a second, very similar rule in this codebase (`actualTotalCents`
 * in packages/core/approvals) and D-42 exists because a comment once claimed
 * they were the same. They diverge exactly when recorded parts exceed the
 * invoice, and the right one here is unambiguous: a claim is about what the
 * repair COST, which is what the books record and what the adjuster is shown,
 * not what the approval ceiling had to measure.
 */
export interface ClaimPositionFacts {
  jobs: readonly JobCost[]
  payments: readonly { category: PaymentCategory; amountCents: number }[]
  /// From the policy. Null when the policy on file does not record one.
  deductibleCents: number | null
}

export interface ClaimPosition {
  /// Summed from the linked work orders. Never typed in.
  repairCostCents: number
  paidCents: number
  paidByCategory: Record<PaymentCategory, number>
  deductibleCents: number | null
  /// Repair cost less the deductible — what the policy would pay if the whole
  /// loss were covered. Null when no deductible is recorded, because a
  /// recovery figure computed against an unknown deductible is a guess.
  expectedRecoveryCents: number | null
  /// Expected less actually paid. Positive means still outstanding.
  shortfallCents: number | null
  /// The repair cost has not cleared the deductible. Worth saying out loud
  /// before a claim is filed at all.
  belowDeductible: boolean
}

export function claimPosition(facts: ClaimPositionFacts): ClaimPosition {
  const repairCostCents = facts.jobs.reduce((sum, job) => sum + jobCostCents(job), 0)

  const paidByCategory: Record<PaymentCategory, number> = {
    REPAIR: 0,
    LOSS_OF_RENTS: 0,
    CONTENTS: 0,
    OTHER: 0,
  }
  for (const payment of facts.payments) paidByCategory[payment.category] += payment.amountCents
  const paidCents = facts.payments.reduce((sum, payment) => sum + payment.amountCents, 0)

  const deductibleCents = facts.deductibleCents
  if (deductibleCents == null) {
    return {
      repairCostCents,
      paidCents,
      paidByCategory,
      deductibleCents: null,
      expectedRecoveryCents: null,
      shortfallCents: null,
      belowDeductible: false,
    }
  }

  const expectedRecoveryCents = Math.max(0, repairCostCents - deductibleCents)
  return {
    repairCostCents,
    paidCents,
    paidByCategory,
    deductibleCents,
    expectedRecoveryCents,
    // Compared against the REPAIR half only. Loss-of-rents and contents
    // proceeds are paid under different limits and netting them against a
    // building shortfall would report a claim as settled while the building
    // half was still short.
    shortfallCents: expectedRecoveryCents - paidByCategory.REPAIR,
    belowDeductible: repairCostCents > 0 && repairCostCents <= deductibleCents,
  }
}

export const BELOW_DEDUCTIBLE_WARNING =
  'The repair cost recorded so far has not cleared the deductible, so this claim would pay nothing. A filed claim sits on your loss history whether or not it pays, and enough of them changes what renewal costs — worth deciding deliberately rather than discovering at settlement.'

// ---------------------------------------------------------------------------
// The file: events and correspondence
// ---------------------------------------------------------------------------

/**
 * One vocabulary for the timeline and the correspondence log, because they
 * are one thing: what happened, when, and what paper it left. Splitting them
 * would mean reading two lists to answer "what has the carrier actually said".
 */
export const CLAIM_EVENT_KINDS = [
  'REPORTED',
  'ADJUSTER_ASSIGNED',
  'INSPECTION',
  'ESTIMATE_RECEIVED',
  'CORRESPONDENCE_IN',
  'CORRESPONDENCE_OUT',
  'OFFER',
  'NOTE',
] as const

export type ClaimEventKind = (typeof CLAIM_EVENT_KINDS)[number]

export function isClaimEventKind(value: string): value is ClaimEventKind {
  return (CLAIM_EVENT_KINDS as readonly string[]).includes(value)
}

export const CLAIM_EVENT_KIND_LABELS: Record<ClaimEventKind, string> = {
  REPORTED: 'Reported to the carrier',
  ADJUSTER_ASSIGNED: 'Adjuster assigned',
  INSPECTION: 'Adjuster inspected',
  ESTIMATE_RECEIVED: 'Estimate or scope received',
  CORRESPONDENCE_IN: 'Received from the carrier',
  CORRESPONDENCE_OUT: 'Sent to the carrier',
  OFFER: 'Offer made',
  NOTE: 'Note',
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

export const CLAIM_OUTCOMES = [
  'PAID',
  /// Settled for less than the claim, and the file says why. Its own outcome
  /// rather than a flag on PAID, because "we took a haircut" is the thing a
  /// later renewal conversation and a later coverage review both ask about.
  'PARTIALLY_PAID',
  'DENIED',
  /// Withdrawn before settlement — most often on discovering the loss is
  /// under the deductible.
  'WITHDRAWN',
] as const

export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number]

export function isClaimOutcome(value: string): value is ClaimOutcome {
  return (CLAIM_OUTCOMES as readonly string[]).includes(value)
}

export const CLAIM_OUTCOME_LABELS: Record<ClaimOutcome, string> = {
  PAID: 'Paid in full',
  PARTIALLY_PAID: 'Settled for less than claimed',
  DENIED: 'Denied by the carrier',
  WITHDRAWN: 'Withdrawn before settlement',
}

interface Violation {
  field: string
  message: string
}

export interface ClaimClosureFacts {
  outcome: ClaimOutcome
  outcomeNote: string
  /// Every payment recorded against the claim.
  paidCents: number
}

/**
 * A claim is refused a close it cannot account for.
 *
 * The two refusals are opposite shapes of the same mistake. A DENIED or
 * WITHDRAWN claim carrying money is a contradiction — somebody recorded a
 * payment and then filed the claim as having paid nothing, and the P&L will
 * disagree with the claim file for ever. A PAID claim carrying no money is
 * the same error the other way round, and it is the commoner one: the cheque
 * arrived, it was banked, and nobody came back to the screen.
 */
export function validateClaimClosure(facts: ClaimClosureFacts): Violation[] {
  const violations: Violation[] = []

  if (facts.outcomeNote.trim().length < 20) {
    violations.push({
      field: 'outcomeNote',
      message:
        'Say how this ended. A claim marked settled with no account of what was agreed is the record nobody can use at the next renewal, which is when it gets read.',
    })
  }

  const noMoneyExpected = facts.outcome === 'DENIED' || facts.outcome === 'WITHDRAWN'
  if (noMoneyExpected && facts.paidCents > 0) {
    violations.push({
      field: 'outcome',
      message:
        'This claim has payments recorded against it, so it cannot be closed as denied or withdrawn. Either the payments belong to a different claim, or the outcome is a partial settlement.',
    })
  }
  if (!noMoneyExpected && facts.paidCents === 0) {
    violations.push({
      field: 'outcome',
      message:
        'No payment has been recorded against this claim, so it cannot be closed as paid. Record what actually arrived first — the P&L reads the payments, not the outcome.',
    })
  }

  return violations
}
