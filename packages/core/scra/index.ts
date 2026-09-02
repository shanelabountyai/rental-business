// The Servicemembers Civil Relief Act (RISK-12, R-085).
//
// ==========================================================================
// THE ONE STATUTE IN THIS PRODUCT THAT IS NOT JURISDICTION CONFIGURATION.
//
// D-4 is categorical: grace periods, late-fee caps, notice periods and cure
// clocks are versioned per-state configuration and never hardcoded. This
// file breaks that rule on purpose, and the exception is narrow and worth
// stating: the SCRA is FEDERAL (50 U.S.C. §§ 3901-4043), uniform across
// every state, and it PREEMPTS state landlord-tenant law where the two
// disagree. There is no state that gets its own §3955 notice period, so a
// `JurisdictionRule` column for it would be a configuration point with
// exactly one correct value in fifty rows - and fifty chances to get one
// wrong.
//
// The practical consequence downstream: an SCRA termination does NOT run
// through `noticePeriodCheck`. A state's `noticeToVacateDays` is not a floor
// the servicemember has to clear; it is a rule §3955 overrides. Warning that
// their notice is "short" would be telling them their federal right is a
// problem.
// ==========================================================================
//
// NOTHING HERE DECIDES WHETHER SOMEBODY IS COVERED. Eligibility turns on
// facts this product cannot verify - when the lease was signed relative to
// entry into service, whether orders are for 90 days or more, whether a
// dependent is the one invoking it. The product records which basis was
// claimed, requires the orders on file, computes the one date the statute
// specifies, and leaves the judgement where it belongs.

import { addBusinessDays, dueDateOnOrAfter, type BusinessDate } from '../scheduling/local-time.ts'

// ---------------------------------------------------------------------------
// §3955 — termination of a residential lease
// ---------------------------------------------------------------------------

/**
 * Which limb of §3955(b) is being invoked.
 *
 * Recorded rather than decided. The two are not interchangeable on the
 * record: one says "I was a civilian when I signed this and then I enlisted",
 * the other says "I was already serving and the Army has moved me", and an
 * owner disputing a termination disputes one or the other, never both.
 */
export const SCRA_TERMINATION_BASES = [
  /// §3955(b)(1): the lease was executed BEFORE the tenant entered military
  /// service, and they have since entered it.
  'entered_service',
  /// §3955(b)(2): the tenant was already serving when they signed, and has
  /// since received permanent-change-of-station orders, or orders to deploy
  /// with a military unit (or as an individual in support of a military
  /// operation) for a period of not less than 90 days.
  'pcs_or_deployment',
] as const

export type ScraTerminationBasis = (typeof SCRA_TERMINATION_BASES)[number]

export function isScraTerminationBasis(value: string): value is ScraTerminationBasis {
  return (SCRA_TERMINATION_BASES as readonly string[]).includes(value)
}

export const SCRA_BASIS_LABELS: Record<ScraTerminationBasis, string> = {
  entered_service: 'Signed before entering service — §3955(b)(1)',
  pcs_or_deployment: 'PCS orders or a deployment of 90 days or more — §3955(b)(2)',
}

export const SCRA_BASIS_EVIDENCE: Record<ScraTerminationBasis, string> = {
  entered_service:
    'A copy of the enlistment or commissioning orders showing the date service began.',
  pcs_or_deployment:
    'A copy of the PCS or deployment orders. Deployment orders must show a period of 90 days or more.',
}

export interface ScraTerminationInput {
  deliveredOn: BusinessDate
  rentDueDay: number
  basis: ScraTerminationBasis
  /// Whether the orders themselves are on file. §3955(c)(1) requires the
  /// notice to be accompanied by a copy of the orders - a termination
  /// recorded without them is a claim with nothing behind it.
  hasOrdersOnFile: boolean
}

export type ScraTerminationRefusal = 'no_orders'

export interface ScraTermination {
  effectiveOn: BusinessDate
  /// The rent due date the 30 days run from, kept so the screen can show the
  /// arithmetic rather than a bare answer somebody has to trust.
  runsFromRentDue: BusinessDate
  refusal?: ScraTerminationRefusal
}

/**
 * The whole §3955 computation, with the one refusal it carries.
 *
 * §3955(d)(1), for a lease providing for MONTHLY rent: termination is
 * effective 30 days after the first date on which the next rental payment is
 * due and payable AFTER the date the notice was delivered.
 *
 * ==========================================================================
 * "AFTER", NOT "ON OR AFTER", AND THE DIFFERENCE IS A WHOLE MONTH.
 *
 * Notice delivered on 1 August against rent due on the 1st: a payment due ON
 * the delivery date is not due "after" it, so the next one is 1 September
 * and the tenancy ends 1 October. Reading it as "on or after" would end the
 * tenancy on 31 August - a month of rent the owner is owed and would never
 * bill, or a month the tenant pays and should not.
 *
 * That worked example (1 August in, 1 October out) is the one every SCRA
 * guide leads with, which is why it is also the first test of this function.
 * (Until R-149 the same computation existed twice - `scraTerminationDate`
 * carried this header and the tests while THIS body, the one the product
 * calls, was a second copy nothing tested directly.)
 * ==========================================================================
 *
 * `rentDueDay` is clamped to the length of the month by `dueDateInMonth`, so
 * a lease with rent due on the 31st behaves in February.
 *
 * The date is returned even when the orders are missing, deliberately: a PM
 * on the phone with a tenant needs to be able to say "that would end it on
 * the 1st of October, and I need the orders before I can record it".
 */
export function scraTermination(input: ScraTerminationInput): ScraTermination {
  const dayAfterDelivery = addBusinessDays(input.deliveredOn, 1)
  const runsFromRentDue = dueDateOnOrAfter(dayAfterDelivery, input.rentDueDay)
  return {
    effectiveOn: addBusinessDays(runsFromRentDue, 30),
    runsFromRentDue,
    ...(input.hasOrdersOnFile ? {} : { refusal: 'no_orders' as const }),
  }
}

export const SCRA_TERMINATION_REFUSAL_MESSAGES: Record<ScraTerminationRefusal, string> = {
  no_orders:
    'Attach the military orders before recording this. §3955(c)(1) requires the notice to be accompanied by a copy of them, and a termination on file with nothing behind it is the one an owner disputes.',
}

// ---------------------------------------------------------------------------
// §3931 — the affidavit before a default judgment
// ---------------------------------------------------------------------------

/**
 * What a DMDC search said.
 *
 * ==========================================================================
 * THERE IS NO ADAPTER BEHIND THIS, AND THERE SHOULD NOT BE ONE.
 *
 * D-7 gives this product simulated adapters for screening, e-sign and
 * listing syndication because each of those has a real vendor API waiting
 * behind it. The SCRA lookup does not: the Defense Manpower Data Center
 * serves single-record requests through a web form that returns a signed PDF
 * certificate, and bulk requests through an authenticated file upload. There
 * is no per-tenant REST call to stand a simulator in front of.
 *
 * So the product does what it can honestly do - record that a human ran the
 * search, when, what it said, and store the certificate they got back - and
 * does not mint a fake result from a fake API. That is D-15's call on the
 * retail-cash rail applied to a different absent vendor: a driver that
 * invents results is untested code that looks finished.
 * ==========================================================================
 */
export const SCRA_LOOKUP_RESULTS = [
  /// The certificate says the person IS on active duty. Everything about the
  /// case changes: §3931 protections apply, §3932 stays are available, and
  /// §3951 bars eviction from premises under the rent ceiling without a
  /// court order.
  'in_service',
  /// The certificate says they are not. This is the finding the affidavit
  /// actually needs in the ordinary case, and it is only good as of its own
  /// search date.
  'not_in_service',
  /// DMDC could not match on the identifiers given - usually a missing date
  /// of birth or SSN. NOT the same as `not_in_service`, and treating it as
  /// such is how a false affidavit gets signed: §3931(b)(4) contemplates
  /// exactly this case and provides for a bond rather than a bare
  /// declaration.
  'indeterminate',
] as const

export type ScraLookupResult = (typeof SCRA_LOOKUP_RESULTS)[number]

export function isScraLookupResult(value: string): value is ScraLookupResult {
  return (SCRA_LOOKUP_RESULTS as readonly string[]).includes(value)
}

export const SCRA_LOOKUP_RESULT_LABELS: Record<ScraLookupResult, string> = {
  in_service: 'On active duty',
  not_in_service: 'Not on active duty',
  indeterminate: 'No match — identifiers insufficient',
}

/**
 * How stale a search may be and still support an affidavit.
 *
 * The statute sets no interval. Courts do, in practice, and they are not
 * uniform - so this is a house rule rather than a legal one, deliberately
 * conservative, and it warns rather than refuses. A search run the week the
 * notice went out and relied on at a hearing three months later is the
 * situation this exists to catch.
 *
 * ponytail: one number for every court. A per-jurisdiction figure would be a
 * `JurisdictionRule` column, and no state has published one to put in it.
 */
export const LOOKUP_STALE_AFTER_DAYS = 30

export interface AffidavitInput {
  /// Whether the tenant appeared in the action. §3931 applies only where the
  /// defendant does NOT appear - a contested hearing needs no affidavit, and
  /// demanding one there would be the product inventing a requirement.
  ///
  /// Null means nobody has said yet, which is treated as "not established"
  /// rather than assumed either way.
  tenantAppeared: boolean | null
  /// The most recent search on file for this tenancy, if any.
  lookup: { result: ScraLookupResult; searchedOn: BusinessDate } | null
  today: BusinessDate
}

export type AffidavitRefusal =
  /// A default judgment with no search on file at all. The one hard stop.
  | 'no_lookup'
  /// The search says the tenant IS serving. A default judgment against a
  /// servicemember needs appointed counsel and, for a residential eviction,
  /// §3951's court order - not an affidavit and a rubber stamp.
  | 'in_service'
  /// DMDC could not match. §3931(b)(4)'s bond route, or better identifiers.
  | 'indeterminate'

export interface AffidavitReadiness {
  ready: boolean
  refusal?: AffidavitRefusal
  /// True when a search exists, supports the affidavit, and is older than
  /// `LOOKUP_STALE_AFTER_DAYS`. A warning, never a refusal.
  stale?: boolean
  staleDays?: number
}

/**
 * Whether a judgment may be recorded (PAY-14's ladder, R-083) given §3931.
 *
 * ==========================================================================
 * THE ONLY THING IN THIS FILE THAT REFUSES, AND ONLY ON ONE PATH.
 *
 * R-084 settled (D-79) that a hold WARNS on the eviction screens and blocks
 * nothing, because serving and filing are sometimes lawful under every hold
 * and a block would push the operator into lifting it. This is the exception
 * the same reasoning produces rather than contradicts: a default judgment
 * without the §3931 affidavit is not "sometimes lawful" - it is voidable on
 * the servicemember's application, and a knowingly false affidavit is a
 * criminal offence under §3931(c). The operator's workaround here is not to
 * destroy a record; it is to go and run the search, which takes a minute and
 * is the thing they were always supposed to do.
 *
 * A CONTESTED judgment is not gated at all. `tenantAppeared === true` and
 * §3931 simply does not apply.
 * ==========================================================================
 */
export function affidavitReadiness(input: AffidavitInput): AffidavitReadiness {
  if (input.tenantAppeared === true) return { ready: true }

  if (!input.lookup) return { ready: false, refusal: 'no_lookup' }
  if (input.lookup.result === 'in_service') return { ready: false, refusal: 'in_service' }
  if (input.lookup.result === 'indeterminate') return { ready: false, refusal: 'indeterminate' }

  const staleDays = daysBetween(input.lookup.searchedOn, input.today)
  if (staleDays > LOOKUP_STALE_AFTER_DAYS) return { ready: true, stale: true, staleDays }
  return { ready: true }
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const ms = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()
  return Math.round(ms / 86_400_000)
}

export const AFFIDAVIT_REFUSAL_MESSAGES: Record<AffidavitRefusal, string> = {
  no_lookup:
    'A default judgment needs the §3931 military-service affidavit, and the affidavit needs a DMDC search behind it. Run the search at scra.dmdc.osd.mil, record the result here and attach the certificate. A judgment entered without one can be reopened on the servicemember’s application.',
  in_service:
    'The search says this tenant IS on active duty. A default judgment against a servicemember needs appointed counsel, and a residential eviction needs a court order under §3951 whatever the lease says. This is an attorney’s call, not a stage to record.',
  indeterminate:
    'The search could not match this tenant, which is not the same as “not serving”. Re-run it with a date of birth or SSN, or take §3931(b)(4)’s bond route — signing the affidavit on a no-match is how a false one gets signed.',
}

export function staleLookupWarning(days: number): string {
  return `The DMDC search on file is ${days} days old. Courts expect one close to the judgment date — re-run it before the hearing if you can.`
}
