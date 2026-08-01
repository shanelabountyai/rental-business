import 'server-only'

import {
  type BusinessDate,
  businessDateToUtc,
  isDue,
} from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'

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

export interface RunSummary {
  jobType: string
  propertyId: string
  businessDate: BusinessDate
  outcome: 'ran' | 'not_due' | 'already_ran' | 'failed'
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

  const summaries: RunSummary[] = []

  for (const property of properties) {
    for (const job of SCHEDULED_JOBS) {
      summaries.push(await runOne(job, property, now))
    }
  }

  return summaries
}

async function runOne(
  job: ScheduledJob,
  property: { id: string; timezone: string },
  now: Date,
): Promise<RunSummary> {
  let due: ReturnType<typeof isDue>
  try {
    due = isDue(now, property.timezone, job.localHour)
  } catch (error) {
    // A property with an unusable timezone must be loud, not skipped: every
    // nightly job for it would otherwise be silently wrong forever.
    return {
      jobType: job.type,
      propertyId: property.id,
      businessDate: 'unknown',
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const base = {
    jobType: job.type,
    propertyId: property.id,
    businessDate: due.businessDate,
  }
  if (!due.due) return { ...base, outcome: 'not_due' }

  // Claiming the run IS the lock. Two concurrent cron invocations both reach
  // here; the unique index lets exactly one create the row, and the loser sees
  // a conflict and stops. Checking-then-inserting would let both through.
  try {
    await prisma.jobRun.create({
      data: {
        jobType: job.type,
        propertyId: property.id,
        businessDate: businessDateToUtc(due.businessDate),
        status: 'RUNNING',
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { ...base, outcome: 'already_ran' }
    throw error
  }

  try {
    const result = await job.run({
      propertyId: property.id,
      timezone: property.timezone,
      businessDate: due.businessDate,
      now,
    })
    await finish(job, property.id, due.businessDate, {
      status: 'SUCCEEDED',
      result: (result ?? {}) as Prisma.InputJsonValue,
    })
    return { ...base, outcome: 'ran' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finish(job, property.id, due.businessDate, {
      status: 'FAILED',
      error: message,
    })
    // The failed run row STAYS. It records that the job was attempted and
    // failed, which is what a support conversation needs; a retry is a
    // deliberate act (clear the row) rather than something the next tick does
    // by accident and repeats sixty times before anyone notices.
    return { ...base, outcome: 'failed', error: message }
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  )
}
