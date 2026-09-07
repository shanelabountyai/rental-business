import 'server-only'

import {
  addBusinessDays,
  type BusinessDate,
  businessDateToUtc,
  isDue,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { CATCH_UP_BUSINESS_DAYS, SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

/**
 * Job health, for the panel R-174 builds.
 *
 * ==========================================================================
 * THE REGISTRY IS THE SPINE, NOT THE `JobRun` TABLE.
 *
 * Listing distinct `jobType`s out of the run rows would be one query and no
 * import, and it would hide the single worst case this screen exists to
 * catch: a job that has never run ANYWHERE. That row has no history to be
 * listed by, so a history-driven panel reports perfect health for a job that
 * has never once fired. Reading `SCHEDULED_JOBS` means every registered job
 * appears whether or not it has ever produced a row.
 * ==========================================================================
 *
 * Portfolio-wide by construction (`job.manage` is not a scoped permission),
 * so there is no scope filter here. Every caller guards itself.
 */

export interface FailedRun {
  id: string
  jobType: string
  propertyId: string
  propertyName: string
  businessDate: BusinessDate
  error: string | null
  attempts: number
  startedAt: Date
}

export interface JobHealthRow {
  type: string
  description: string
  localHour: number
  /// When this job last finished successfully ANYWHERE. Portfolio-wide
  /// rather than per property on purpose: the question this line answers is
  /// "is this job alive at all", and the per-property answer is the two
  /// lists below it.
  lastSuccessAt: Date | null
  /// Properties whose local clock has passed this job's hour today and which
  /// still have no run row for their own today. Not "every property with no
  /// row" - a job due at 02:00 has legitimately not run yet at a property
  /// where it is still Tuesday evening, and reporting that as a miss makes
  /// the panel cry wolf every evening.
  overdueToday: { propertyId: string; propertyName: string }[]
  /// Business dates inside the catch-up window with no run row, at properties
  /// that DID run this job on some other date in the window. Past the window
  /// the runner deliberately stops filling them in, so this is the list a
  /// person has to decide about.
  missedDates: { propertyName: string; date: BusinessDate }[]
  failed: FailedRun[]
}

export async function jobHealth(now = new Date()): Promise<JobHealthRow[]> {
  const properties = await prisma.property.findMany({
    where: { active: true },
    select: { id: true, name: true, timezone: true },
    orderBy: { name: 'asc' },
  })
  const nameOf = new Map(properties.map((p) => [p.id, p.name]))

  // One window query for the whole panel, the same shape and the same reason
  // as the runner's own `recentHistory`.
  const floor = addBusinessDays(
    utcToBusinessDate(now),
    -(CATCH_UP_BUSINESS_DAYS + 2),
  )
  const [recent, failed, lastSuccesses] = await Promise.all([
    prisma.jobRun.findMany({
      where: { businessDate: { gte: businessDateToUtc(floor) } },
      select: { jobType: true, propertyId: true, businessDate: true },
    }),
    prisma.jobRun.findMany({
      where: { status: 'FAILED' },
      select: {
        id: true,
        jobType: true,
        propertyId: true,
        businessDate: true,
        error: true,
        attempts: true,
        startedAt: true,
      },
      orderBy: { startedAt: 'desc' },
      // The 50 most recent failures across every job, then split per job
      // below. A failure sitting unlooked-at for months is a different
      // conversation from last night's, and a panel listing two hundred of
      // them is one nobody reads. The cap bounds the SCREEN, not the truth -
      // every failure also raised a `job_failed` Task, and that queue holds
      // all of them.
      take: 50,
    }),
    prisma.jobRun.groupBy({
      by: ['jobType'],
      where: { status: 'SUCCEEDED' },
      _max: { finishedAt: true },
    }),
  ])

  const ran = new Set(
    recent.map(
      (row) =>
        `${row.jobType} ${row.propertyId ?? ''} ${utcToBusinessDate(row.businessDate)}`,
    ),
  )

  const lastSuccessAt = new Map(
    lastSuccesses
      .filter((row) => row._max.finishedAt != null)
      .map((row) => [row.jobType, row._max.finishedAt as Date]),
  )

  return SCHEDULED_JOBS.map((job) => {
    const overdueToday: JobHealthRow['overdueToday'] = []
    const missedDates: JobHealthRow['missedDates'] = []

    for (const property of properties) {
      let due: ReturnType<typeof isDue>
      try {
        due = isDue(now, property.timezone, job.localHour)
      } catch {
        // An unusable timezone is already reported as a failed run by the
        // runner itself; it must not take this whole panel down with it.
        continue
      }
      const today = due.businessDate
      if (due.due && !ran.has(`${job.type} ${property.id} ${today}`)) {
        overdueToday.push({ propertyId: property.id, propertyName: property.name })
      }

      // Same rule as the runner's `missedDates`: a gap only counts where the
      // pair has an earlier run to prove the job was live then.
      let sawEarlierRun = ran.has(
        `${job.type} ${property.id} ${addBusinessDays(today, -(CATCH_UP_BUSINESS_DAYS + 1))}`,
      )
      for (let back = CATCH_UP_BUSINESS_DAYS; back >= 1; back -= 1) {
        const date = addBusinessDays(today, -back)
        if (ran.has(`${job.type} ${property.id} ${date}`)) {
          sawEarlierRun = true
          continue
        }
        if (sawEarlierRun) missedDates.push({ propertyName: property.name, date })
      }
    }

    return {
      type: job.type,
      description: job.description,
      localHour: job.localHour,
      lastSuccessAt: lastSuccessAt.get(job.type) ?? null,
      overdueToday,
      missedDates,
      failed: failed
        .filter((row) => row.jobType === job.type)
        .map((row) => ({
          id: row.id,
          jobType: row.jobType,
          propertyId: row.propertyId ?? '',
          propertyName:
            nameOf.get(row.propertyId ?? '') ??
            'a property that is no longer active',
          businessDate: utcToBusinessDate(row.businessDate),
          error: row.error,
          attempts: row.attempts,
          startedAt: row.startedAt,
        })),
    }
  })
}
