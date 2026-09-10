import 'server-only'

import {
  addBusinessDays,
  type BusinessDate,
  businessDateToUtc,
  isDue,
  utcToBusinessDate,
  wallClockToUtc,
} from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The scheduled-job runner.
//
// The cron ticks hourly (vercel.json). Every tick, this asks each property
// "has your local clock reached this job's hour today, and has this job
// already run for your local day?" - so a job fires once per property per
// property-local day (D-3), whatever UTC thinks.
//
// Two layers of idempotency, because either alone is insufficient:
//
//   The due check stops a job running before its hour, and keeps returning
//   true afterwards so a late or missed tick still catches up.
//
//   The unique index on (jobType, propertyId, businessDate) stops that
//   "keeps returning true" from meaning "runs every hour" - and turns the
//   duplicated 01:00 of a fall-back night into one run rather than two.

export interface JobContext {
  propertyId: string
  timezone: string
  businessDate: BusinessDate
  /**
   * ========================================================================
   * ALWAYS AN INSTANT INSIDE `businessDate` AT `timezone` (R-190).
   *
   * On a live run that is the real clock. On a CAUGHT-UP or re-run day it is
   * the job's own local hour on the date being replayed - a past instant,
   * deliberately, because the alternative is what R-190 found: `runOne`
   * passed the real `now` alongside a historical `businessDate`, so six jobs
   * did TODAY's work and the `JobRun` was then recorded SUCCEEDED for
   * yesterday. `payments.chase` was the sharp one - `chaseRungDue` matches
   * days-past-grace EXACTLY, so a cron gap over the day a tenancy hit a rung
   * lost that rung for ever while minting a duplicate Task per catch-up
   * date, and R-174's panel reported the lost day as done.
   *
   * So: a job must read THIS, never `new Date()`, for anything that decides
   * what day it is. A job whose work genuinely cannot be re-dated says so in
   * its own header (`billing.sweep` is the only one today) rather than
   * quietly reading the wall clock.
   * ========================================================================
   */
  now: Date
}

export interface ScheduledJob {
  /// Stable identity. Part of the idempotency key, so renaming a job makes it
  /// re-run for every business date it has already handled.
  type: string
  /// Property-LOCAL hour, 0-23. The whole point of D-3.
  localHour: number
  description: string
  run: (context: JobContext) => Promise<Record<string, unknown> | void>
}

/**
 * The registry. Empty on purpose - R-006 builds the runner, and the items that
 * own the nightly work register here: R-010's late-fee assessment, R-040's
 * charge posting, R-030's reminder ladder, R-045's deposit countdown.
 *
 * Every one of those is a job whose correct day depends on the property's
 * timezone, which is why the primitive exists before any of them.
 */
export const SCHEDULED_JOBS: ScheduledJob[] = []

export function findScheduledJob(type: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((job) => job.type === type)
}

/**
 * How many business dates before today a missed run is still caught up on.
 *
 * ==========================================================================
 * THE BOUND IS THE POINT, NOT THE NUMBER (R-174).
 *
 * `isDue` uses `>=`, so a late tick still catches TODAY - and its own
 * `ponytail:` comment names the gap that leaves: a day whose ticks all failed
 * is skipped for ever, because `businessDate` has already rolled over and
 * nothing ever asks about yesterday again. Four of the jobs standing on that
 * silence run legal clocks - deposit-disposition reminders, court-date
 * reminders, the case stall sweep, the billing sweep - so a lost day is a
 * statutory nudge nobody was ever told did not happen.
 *
 * Three days rather than "everything missing", because an unbounded catch-up
 * is the more dangerous failure. A property whose cron has been dead a
 * fortnight would post two weeks of late fees in one tick and send a
 * fortnight of reminders in one batch, without a human ever deciding that was
 * right. Past the bound the run is genuinely lost, the health panel says so,
 * and a person decides.
 * ==========================================================================
 */
export const CATCH_UP_BUSINESS_DAYS = 3

export interface RunSummary {
  jobType: string
  propertyId: string
  businessDate: BusinessDate
  outcome: 'ran' | 'caught_up' | 'not_due' | 'already_ran' | 'failed'
  error?: string
}

/**
 * Runs every due job for every active property. Called by the cron route.
 *
 * `options.propertyIds` narrows the run to specific properties. The cron never
 * passes it; it exists for backfilling one property after a fix, and for tests
 * that must not touch rows they did not create.
 *
 * Properties are processed sequentially rather than in parallel: a 10-50 unit
 * portfolio is small, the work is database-bound, and a serverless function
 * that opens fifty concurrent transactions against a pooled Neon connection
 * finds the pool before it finds the speedup.
 */
export async function runDueJobs(
  now = new Date(),
  options: { propertyIds?: string[] } = {},
): Promise<RunSummary[]> {
  const properties = await prisma.property.findMany({
    where: {
      active: true,
      ...(options.propertyIds ? { id: { in: options.propertyIds } } : {}),
    },
    select: { id: true, timezone: true },
  })

  const history = await recentHistory(
    now,
    properties.map((property) => property.id),
  )

  const summaries: RunSummary[] = []

  for (const property of properties) {
    for (const job of SCHEDULED_JOBS) {
      summaries.push(...(await runOne(job, property, now, history)))
    }
  }

  return summaries
}

/**
 * Which (job, property, businessDate) triples already have a run row inside
 * the catch-up window.
 *
 * ONE query for the whole tick, not one per pair: with two dozen registered
 * jobs and a fifty-house portfolio, a per-pair lookup is twelve hundred round
 * trips an hour to answer a question whose answer is almost always "nothing is
 * missing".
 */
async function recentHistory(
  now: Date,
  propertyIds: string[],
): Promise<ReadonlySet<string>> {
  if (propertyIds.length === 0) return new Set()
  // A loose UTC floor rather than a per-property one: properties sit in
  // different zones, so their local "today" differs by at most a day.
  // Over-fetching one extra date is cheaper than computing a floor per
  // property, and `missedDates` below is what actually decides.
  const floor = addBusinessDays(
    utcToBusinessDate(now),
    -(CATCH_UP_BUSINESS_DAYS + 2),
  )
  const rows = await prisma.jobRun.findMany({
    where: {
      propertyId: { in: propertyIds },
      businessDate: { gte: businessDateToUtc(floor) },
    },
    select: { jobType: true, propertyId: true, businessDate: true },
  })
  return new Set(
    rows.map((row) =>
      historyKey(
        row.jobType,
        row.propertyId ?? '',
        utcToBusinessDate(row.businessDate),
      ),
    ),
  )
}

function historyKey(
  jobType: string,
  propertyId: string,
  date: BusinessDate,
): string {
  return `${jobType} ${propertyId} ${date}`
}

/**
 * The business dates before `today` this job missed at this property.
 *
 * A date counts as missed only if the pair has an EARLIER run row. That single
 * condition is what stops a newly registered job - or a newly acquired
 * property - from backfilling three days of work on its first tick: with no
 * earlier row there is no evidence the job was ever live on those dates, and
 * inventing that evidence is how a fresh import gets three days of late fees.
 *
 * It also, deliberately, declines to catch up a pair whose last run predates
 * the whole window. That is a cron down longer than the bound, which is a
 * person's decision rather than a tick's.
 */
function missedDates(
  job: ScheduledJob,
  propertyId: string,
  today: BusinessDate,
  history: ReadonlySet<string>,
): BusinessDate[] {
  // The day before the window, so a pair that ran right up to the edge still
  // counts as having been live. `recentHistory` fetches one day further back
  // than the window precisely so this lookup can hit.
  let sawEarlierRun = history.has(
    historyKey(
      job.type,
      propertyId,
      addBusinessDays(today, -(CATCH_UP_BUSINESS_DAYS + 1)),
    ),
  )

  const missed: BusinessDate[] = []
  for (let back = CATCH_UP_BUSINESS_DAYS; back >= 1; back -= 1) {
    const date = addBusinessDays(today, -back)
    if (history.has(historyKey(job.type, propertyId, date))) {
      sawEarlierRun = true
      continue
    }
    if (sawEarlierRun) missed.push(date)
  }
  return missed
}

/**
 * The instant a replayed business date pretends to be happening at: the job's
 * own local hour, on that date, in the property's zone.
 *
 * The job's `localHour` rather than midnight, because that IS the hour the run
 * was scheduled for and missed - a 06:00 late-fee assessment replayed at local
 * midnight is a different question about the same day. `wallClockToUtc`
 * already resolves the DST edges (R-017), which is the whole reason this is
 * three lines and not thirty.
 */
function replayInstant(
  job: ScheduledJob,
  timezone: string,
  date: BusinessDate,
): Date {
  const hour = String(job.localHour).padStart(2, '0')
  return wallClockToUtc(`${date}T${hour}:00`, timezone)
}

async function runOne(
  job: ScheduledJob,
  property: { id: string; timezone: string },
  now: Date,
  history: ReadonlySet<string>,
): Promise<RunSummary[]> {
  let due: ReturnType<typeof isDue>
  try {
    due = isDue(now, property.timezone, job.localHour)
  } catch (error) {
    // A property with an unusable timezone must be loud, not skipped: every
    // nightly job for it would otherwise be silently wrong forever.
    return [
      {
        jobType: job.type,
        propertyId: property.id,
        businessDate: 'unknown',
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
    ]
  }

  const summaries: RunSummary[] = []

  // Missed days first, oldest first. A job that posts a charge and a job that
  // reads yesterday's charges both behave better in date order, and the cost
  // of getting that wrong is silent.
  for (const date of missedDates(job, property.id, due.businessDate, history)) {
    // NOT `now`. The clock consistent with the date being replayed - see
    // `JobContext.now`. `isDue` above has already proved the timezone is
    // usable, so `replayInstant` cannot throw here.
    const summary = await claimAndRun(
      job,
      property,
      date,
      replayInstant(job, property.timezone, date),
    )
    summaries.push(
      summary.outcome === 'ran' ? { ...summary, outcome: 'caught_up' } : summary,
    )
  }

  const base = {
    jobType: job.type,
    propertyId: property.id,
    businessDate: due.businessDate,
  }
  if (!due.due) {
    summaries.push({ ...base, outcome: 'not_due' })
    return summaries
  }

  summaries.push(await claimAndRun(job, property, due.businessDate, now))
  return summaries
}

async function claimAndRun(
  job: ScheduledJob,
  property: { id: string; timezone: string },
  businessDate: BusinessDate,
  now: Date,
): Promise<RunSummary> {
  const base = { jobType: job.type, propertyId: property.id, businessDate }

  // Claiming the run IS the lock. Two concurrent cron invocations both reach
  // here; the unique index lets exactly one create the row, and the loser sees
  // a conflict and stops. Checking-then-inserting would let both through.
  let jobRunId: string
  try {
    const claimed = await prisma.jobRun.create({
      data: {
        jobType: job.type,
        propertyId: property.id,
        businessDate: businessDateToUtc(businessDate),
        status: 'RUNNING',
      },
      select: { id: true },
    })
    jobRunId = claimed.id
  } catch (error) {
    if (isUniqueViolation(error)) return { ...base, outcome: 'already_ran' }
    throw error
  }

  try {
    const result = await job.run({
      propertyId: property.id,
      timezone: property.timezone,
      businessDate,
      now,
    })
    await finish(job, property.id, businessDate, {
      status: 'SUCCEEDED',
      result: (result ?? {}) as Prisma.InputJsonValue,
    })
    return { ...base, outcome: 'ran' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finish(job, property.id, businessDate, {
      status: 'FAILED',
      error: message,
    })
    await raiseFailureTask(job, property.id, businessDate, jobRunId, message)
    // The failed run row STAYS. It records that the job was attempted and
    // failed, which is what a support conversation needs; a retry is a
    // deliberate act (the health panel's re-run control, R-174) rather than
    // something the next tick does by accident and repeats sixty times before
    // anyone notices.
    return { ...base, outcome: 'failed', error: message }
  }
}

/**
 * A failed nightly job becomes a Task, like every other staff queue (D-9).
 *
 * The cron route already writes an AuditLog row for the same event, and that
 * is not a substitute: nothing reads AuditLog on a schedule, and R-174's
 * finding was exactly that a failed run is written down and then read by
 * nobody. A Task is the one thing in this product somebody is actually shown.
 *
 * Keyed on the JobRun's own id, so the same failure collapses onto one task
 * however many times it is looked at, while a different date's failure of the
 * same job raises its own.
 *
 * It must never take the run down with it: a task-creation failure inside the
 * failure handler would replace a recorded, visible job failure with an
 * unhandled throw out of `runDueJobs` that skips every remaining property.
 */
async function raiseFailureTask(
  job: ScheduledJob,
  propertyId: string,
  businessDate: BusinessDate,
  jobRunId: string,
  message: string,
): Promise<void> {
  try {
    await createTask(prisma, {
      propertyId,
      type: 'job_failed',
      subjectType: 'JobRun',
      subjectId: jobRunId,
      businessDate,
      // URGENT, not EMERGENCY: EMERGENCY is life-safety in this product's
      // vocabulary. A nightly job that did not run is a legal clock that did
      // not tick - today's problem, not this hour's.
      priority: 'URGENT',
      title: `${job.description} failed: ${message}`.slice(0, 300),
    })
  } catch {
    // Swallowed on purpose - see the docstring above.
  }
}

export type RerunResult =
  | { ok: true }
  | {
      ok: false
      reason: 'not_found' | 'not_failed' | 'unknown_job' | 'failed'
      error?: string
    }

/**
 * Re-runs one FAILED run, in place. The health panel's re-run control (R-174).
 *
 * ==========================================================================
 * IT REFUSES ANYTHING THAT IS NOT `FAILED`, AND THAT IS THE SAFETY BOUNDARY.
 *
 * Re-running a SUCCEEDED run is how a month of late fees gets posted twice:
 * the jobs in this registry are idempotent per (type, property, businessDate)
 * BECAUSE of the run row, not on their own, so taking away the row's
 * protection takes away all of it. A RUNNING row is either a run still in
 * flight or a process that died mid-run, and telling those apart is a
 * person's judgement rather than a button's.
 *
 * The row is UPDATED rather than replaced, so `attempts` counts up and the
 * original `startedAt` survives. The evidence that the job failed last night
 * is the thing the panel exists to show; a re-run must not erase it.
 * ==========================================================================
 */
export async function rerunJobRun(jobRunId: string): Promise<RerunResult> {
  const run = await prisma.jobRun.findUnique({
    where: { id: jobRunId },
    select: {
      id: true,
      jobType: true,
      status: true,
      businessDate: true,
      property: { select: { id: true, timezone: true } },
    },
  })
  // A portfolio-wide run row has no property, so there is no timezone to run
  // it against. Nothing registers one today; refusing is the honest answer if
  // something ever does.
  if (!run || !run.property) return { ok: false, reason: 'not_found' }
  if (run.status !== 'FAILED') return { ok: false, reason: 'not_failed' }

  const job = findScheduledJob(run.jobType)
  if (!job) return { ok: false, reason: 'unknown_job' }

  const businessDate = utcToBusinessDate(run.businessDate)
  const property = run.property

  // Claim it back. `status: 'FAILED'` in the where clause IS the lock: two
  // people pressing the button at once, or a press racing a cron tick, and
  // exactly one update matches.
  const claimed = await prisma.jobRun.updateMany({
    where: { id: run.id, status: 'FAILED' },
    data: {
      status: 'RUNNING',
      error: null,
      finishedAt: null,
      attempts: { increment: 1 },
    },
  })
  if (claimed.count === 0) return { ok: false, reason: 'not_failed' }

  try {
    const result = await job.run({
      propertyId: property.id,
      timezone: property.timezone,
      businessDate,
      // The date being re-run, not the moment somebody pressed the button
      // (R-190). Unlike the catch-up path this is inside the try: nothing has
      // validated the timezone here, so an unusable one lands the row back on
      // FAILED with the reason on it rather than throwing out of the action.
      now: replayInstant(job, property.timezone, businessDate),
    })
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        result: (result ?? {}) as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    })
    // The task the failure raised is done - the work it named has now
    // happened. Closing it here rather than leaving it to a human is the
    // difference between a queue that means something and one that fills with
    // rows somebody has to remember are stale.
    await prisma.task.updateMany({
      where: { type: 'job_failed', subjectId: run.id, status: 'OPEN' },
      data: { status: 'DONE', completedAt: new Date() },
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', error: message, finishedAt: new Date() },
    })
    return { ok: false, reason: 'failed', error: message }
  }
}

async function finish(
  job: ScheduledJob,
  propertyId: string,
  businessDate: BusinessDate,
  data: Prisma.JobRunUpdateManyMutationInput,
) {
  await prisma.jobRun.updateMany({
    where: {
      jobType: job.type,
      propertyId,
      businessDate: businessDateToUtc(businessDate),
    },
    data: { ...data, finishedAt: new Date() },
  })
}
