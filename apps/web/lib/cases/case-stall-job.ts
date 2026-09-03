import 'server-only'

import { responseClock } from '@rental/core/accommodations'
import { mitigationClock } from '@rental/core/insurance'
import {
  type BusinessDate,
  businessDate,
  businessDaysBetween,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The one stall sweep for the five case types review §7 found with none
// (D-9): accommodation/ESA response clocks, quiet abandonment cases,
// unserved violation-cure notices, silent insurance-claim mitigation, and
// unsigned party-change amendments with an unscreened incoming occupant.
//
// All five raise the SAME `Task` queue - D-9 forbids a second one - and all
// five are flagged ONCE, not every day the condition holds: the check below
// is keyed on (type, subjectId) with no `businessDate` in it, the same shape
// compliance/alert-job.ts already uses, so a case stalled for a month gets
// exactly one Task, not thirty.

const LOCAL_HOUR = 7

async function alreadyFlagged(type: string, subjectId: string): Promise<boolean> {
  const existing = await prisma.task.findFirst({ where: { type, subjectId }, select: { id: true } })
  return existing != null
}

// ---------------------------------------------------------------------------
// 1. Accommodation / ESA response clock (RISK-13, D-89) - ESCALATES
//
// D-89 refuses to pause this clock for anything, including our own request
// for documentation, which makes an unwatched overdue request the single
// worst outcome in the product: unanswered reads as denied. Intake already
// raises `accommodation.respond` at URGENT (accommodations/actions.ts) - this
// escalates to EMERGENCY once `RESPONSE_TARGET_DAYS` has actually run out
// with nobody having decided it, rather than adding a second routine nudge.
// ---------------------------------------------------------------------------
async function checkAccommodations(propertyId: string, today: BusinessDate) {
  const requests = await prisma.accommodationRequest.findMany({
    where: { propertyId, decidedOn: null },
    select: { id: true, receivedOn: true },
  })
  let flagged = 0
  for (const request of requests) {
    const clock = responseClock(utcToBusinessDate(request.receivedOn), null, today)
    if (!clock.overdue) continue
    if (await alreadyFlagged('accommodation.response_overdue', request.id)) continue
    await createTask(prisma, {
      propertyId,
      type: 'accommodation.response_overdue',
      subjectType: 'AccommodationRequest',
      subjectId: request.id,
      businessDate: today,
      priority: 'EMERGENCY',
      title: `Accommodation request unanswered ${clock.daysOutstanding} days — past the FHA response window`,
    })
    flagged++
  }
  return { checked: requests.length, flagged }
}

// ---------------------------------------------------------------------------
// 2. Abandonment attempts gone quiet (RISK-01, R-087)
//
// The evidence bar (`MIN_ATTEMPTS`/`MIN_DISTINCT_METHODS`,
// packages/core/abandonment) is never met by itself - somebody has to keep
// logging attempts. `ABANDONMENT_QUIET_STALL_DAYS` is a house heuristic, not
// a statute (the same posture `WATER_MITIGATION_TARGET_HOURS` states about
// itself): a case with nothing logged in two weeks is going cold before it
// ever clears the bar that lets anyone act on it lawfully.
// ---------------------------------------------------------------------------
const ABANDONMENT_QUIET_STALL_DAYS = 14

async function checkAbandonment(propertyId: string, today: BusinessDate, timezone: string) {
  const cases = await prisma.abandonmentCase.findMany({
    where: { propertyId, status: { not: 'CLOSED' } },
    select: {
      id: true,
      openedAt: true,
      attempts: { orderBy: { attemptedOn: 'desc' }, take: 1, select: { attemptedOn: true } },
    },
  })
  let flagged = 0
  for (const abandonmentCase of cases) {
    const lastActivity = abandonmentCase.attempts[0]
      ? utcToBusinessDate(abandonmentCase.attempts[0].attemptedOn)
      : businessDate(abandonmentCase.openedAt, timezone)
    const quietDays = businessDaysBetween(lastActivity, today)
    if (quietDays < ABANDONMENT_QUIET_STALL_DAYS) continue
    if (await alreadyFlagged('abandonment.case_stalled', abandonmentCase.id)) continue
    await createTask(prisma, {
      propertyId,
      type: 'abandonment.case_stalled',
      subjectType: 'AbandonmentCase',
      subjectId: abandonmentCase.id,
      businessDate: today,
      priority: 'ROUTINE',
      title: `No contact attempt logged in ${quietDays} days on an open abandonment case`,
    })
    flagged++
  }
  return { checked: cases.length, flagged }
}

// ---------------------------------------------------------------------------
// 3. Violation cure notice expired, unserved (RISK-02/03, R-088)
//
// `cureClock` (packages/core/evictions) only ever answers from an ACTUAL
// service - an unserved notice reports `not_served` forever with no
// deadline, because nothing has started its clock. That is correct for the
// legal question and useless for this one: a notice generated and never
// served is an operations failure the legal clock cannot see. This measures
// the same `leaseViolationCureDays` window from the notice's GENERATION date
// instead - never printed on anything a tenant or a court sees, only on this
// Task - and falls back to a fixed house number when the state's own period
// is not yet configured (D-4: never invent a legal deadline, but a stall
// alarm is not one).
// ---------------------------------------------------------------------------
const VIOLATION_UNSERVED_STALL_DAYS_FALLBACK = 14

async function checkViolations(
  propertyId: string,
  today: BusinessDate,
  property: { state: string; county: string | null; timezone: string },
) {
  const cases = await prisma.violationCase.findMany({
    where: { propertyId, status: 'OPEN' },
    select: {
      id: true,
      notices: {
        where: { servedAt: null },
        orderBy: { generatedAt: 'asc' },
        take: 1,
        select: { generatedAt: true },
      },
    },
  })
  const withUnserved = cases.filter((c) => c.notices.length > 0)
  if (withUnserved.length === 0) return { checked: cases.length, flagged: 0 }

  // Configuration failure falls to the fallback number, same posture
  // `violations/queries.ts`'s own `cureFor` takes for a missing rule row.
  const rule = await rulesFor(property, new Date()).catch(() => null)
  const stallDays = rule?.leaseViolationCureDays ?? VIOLATION_UNSERVED_STALL_DAYS_FALLBACK

  let flagged = 0
  for (const violationCase of withUnserved) {
    const generatedOn = businessDate(violationCase.notices[0]!.generatedAt, property.timezone)
    if (businessDaysBetween(generatedOn, today) < stallDays) continue
    if (await alreadyFlagged('violation.cure_unserved_stalled', violationCase.id)) continue
    await createTask(prisma, {
      propertyId,
      type: 'violation.cure_unserved_stalled',
      subjectType: 'ViolationCase',
      subjectId: violationCase.id,
      businessDate: today,
      priority: 'ROUTINE',
      title: `A violation notice has sat unserved since ${friendlyBusinessDate(generatedOn)}`,
    })
    flagged++
  }
  return { checked: cases.length, flagged }
}

// ---------------------------------------------------------------------------
// 4. Insurance claim silent past the mitigation target (RISK-07, R-089)
//
// `mitigationClock` already computes exactly this - `urgent` is true only
// for a WATER loss where nothing has been recorded as started past
// `WATER_MITIGATION_TARGET_HOURS`. Nothing new to compute; this job's whole
// contribution is noticing that nobody has looked.
// ---------------------------------------------------------------------------
async function checkInsuranceClaims(propertyId: string, today: BusinessDate, now: Date) {
  const claims = await prisma.insuranceClaim.findMany({
    where: { propertyId, status: 'OPEN', cause: 'WATER', mitigationStartedAt: null },
    select: { id: true, incidentAt: true, cause: true },
  })
  let flagged = 0
  for (const claim of claims) {
    const clock = mitigationClock(claim.incidentAt, null, claim.cause, now)
    if (!clock.urgent) continue
    if (await alreadyFlagged('insurance_claim.mitigation_stalled', claim.id)) continue
    await createTask(prisma, {
      propertyId,
      type: 'insurance_claim.mitigation_stalled',
      subjectType: 'InsuranceClaim',
      subjectId: claim.id,
      businessDate: today,
      priority: 'ROUTINE',
      title: `No mitigation recorded ${Math.round(clock.hoursElapsed)}h after a water loss`,
    })
    flagged++
  }
  return { checked: claims.length, flagged }
}

// ---------------------------------------------------------------------------
// 5. Party-change amendment unsigned, incoming occupant unscreened (RISK-10, R-090)
//
// The database CHECK on `LeasePartyChangeParty` already refuses an incoming
// party with no `applicantId` at all - what it cannot refuse is one whose
// screening was ordered and never decided (`ScreeningReport.decision` still
// null). `PARTY_CHANGE_STALL_DAYS` is a house number: a replacement who was
// screened usually signs within days, and an amendment sitting this long
// BOTH unsigned and unscreened is the worst combination the case can be in -
// somebody may already be living there with nobody having decided whether
// they should.
// ---------------------------------------------------------------------------
const PARTY_CHANGE_STALL_DAYS = 3

async function checkPartyChanges(propertyId: string, today: BusinessDate, timezone: string) {
  const changes = await prisma.leasePartyChange.findMany({
    where: { status: 'PENDING_SIGNATURE', lease: { propertyId } },
    select: {
      id: true,
      createdAt: true,
      parties: {
        where: { direction: 'INCOMING' },
        select: { applicant: { select: { screeningReport: { select: { decision: true } } } } },
      },
    },
  })
  let flagged = 0
  for (const change of changes) {
    const unscreened = change.parties.some((party) => !party.applicant?.screeningReport?.decision)
    if (!unscreened) continue
    const createdOn = businessDate(change.createdAt, timezone)
    if (businessDaysBetween(createdOn, today) < PARTY_CHANGE_STALL_DAYS) continue
    if (await alreadyFlagged('party_change.unsigned_unscreened_stalled', change.id)) continue
    await createTask(prisma, {
      propertyId,
      type: 'party_change.unsigned_unscreened_stalled',
      subjectType: 'LeasePartyChange',
      subjectId: change.id,
      businessDate: today,
      priority: 'ROUTINE',
      title: 'Party-change amendment still unsigned with an unscreened incoming occupant',
    })
    flagged++
  }
  return { checked: changes.length, flagged }
}

SCHEDULED_JOBS.push({
  type: 'cases.stalled',
  localHour: LOCAL_HOUR,
  description:
    'One stall sweep for the five case types nothing else watches (review §7): accommodation response clocks, quiet abandonment cases, unserved violation-cure notices, silent insurance-claim mitigation, and unsigned/unscreened party-change amendments.',
  run: async ({ propertyId, businessDate: today, now }) => {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { state: true, county: true, timezone: true },
    })

    return {
      accommodations: await checkAccommodations(propertyId, today),
      abandonment: await checkAbandonment(propertyId, today, property.timezone),
      violations: await checkViolations(propertyId, today, property),
      insuranceClaims: await checkInsuranceClaims(propertyId, today, now),
      partyChanges: await checkPartyChanges(propertyId, today, property.timezone),
    }
  },
})
