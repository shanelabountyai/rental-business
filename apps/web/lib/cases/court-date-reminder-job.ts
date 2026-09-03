import 'server-only'

import { LOOKUP_STALE_AFTER_DAYS } from '@rental/core/scra'
import { businessDate, businessDaysBetween, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { affidavitLookupFor } from '@/lib/scra/queries.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Court-date reminders (RISK-09, review §9).
//
// `EvictionCase.courtDate` is stored, displayed, and until now never
// scheduled against - a missed hearing loses by default at the highest
// cost-per-occurrence in the product. Three Tasks, each flagged once
// (the same (type, subjectId) guard case-stall-job.ts and
// deposit-disposition-reminder-job.ts already use, because `createTask`'s
// own uniqueness is per businessDate and this job runs daily against the
// same still-upcoming hearing): seven days out, one day out, and - inside
// that same seven-day window - a warning when the DMDC search on file is
// stale, turning R-085's render-only `staleLookupWarning` into something
// that actually reaches someone before the hearing rather than only a
// staff member who happens to open the case page.

const LOCAL_HOUR = 7

async function alreadyFlagged(type: string, subjectId: string): Promise<boolean> {
  const existing = await prisma.task.findFirst({ where: { type, subjectId }, select: { id: true } })
  return existing != null
}

SCHEDULED_JOBS.push({
  type: 'evictions.court_date_reminders',
  localHour: LOCAL_HOUR,
  description:
    'Tasks at T-7 and T-1 before a scheduled eviction hearing, plus a Task inside that week when the DMDC search on file is more than 30 days stale (RISK-09, R-085).',
  run: async ({ propertyId, businessDate: today, timezone }) => {
    const cases = await prisma.evictionCase.findMany({
      where: { propertyId, stage: { not: 'CLOSED' }, courtDate: { not: null } },
      select: { id: true, leaseId: true, courtDate: true, unit: { select: { name: true } } },
    })

    let flagged = 0
    for (const evictionCase of cases) {
      const hearingDay = businessDate(evictionCase.courtDate!, timezone)
      const daysUntil = businessDaysBetween(today, hearingDay)
      const when = friendlyTimestamp(evictionCase.courtDate!, timezone)

      if (daysUntil === 7 && !(await alreadyFlagged('eviction.court_date_t7', evictionCase.id))) {
        await createTask(prisma, {
          propertyId,
          type: 'eviction.court_date_t7',
          subjectType: 'EvictionCase',
          subjectId: evictionCase.id,
          businessDate: today,
          priority: 'ROUTINE',
          title: `Hearing in 7 days (${when}) — ${evictionCase.unit.name}`,
        })
        flagged++
      }

      if (daysUntil === 1 && !(await alreadyFlagged('eviction.court_date_t1', evictionCase.id))) {
        await createTask(prisma, {
          propertyId,
          type: 'eviction.court_date_t1',
          subjectType: 'EvictionCase',
          subjectId: evictionCase.id,
          businessDate: today,
          priority: 'URGENT',
          title: `Hearing tomorrow (${when}) — ${evictionCase.unit.name}`,
        })
        flagged++
      }

      if (daysUntil >= 0 && daysUntil <= 7 && !(await alreadyFlagged('eviction.scra_search_stale', evictionCase.id))) {
        const lookup = await affidavitLookupFor(evictionCase.leaseId)
        const staleDays = lookup ? businessDaysBetween(lookup.searchedOn, today) : null
        if (staleDays !== null && staleDays > LOOKUP_STALE_AFTER_DAYS) {
          await createTask(prisma, {
            propertyId,
            type: 'eviction.scra_search_stale',
            subjectType: 'EvictionCase',
            subjectId: evictionCase.id,
            businessDate: today,
            priority: 'ROUTINE',
            title: `DMDC search is ${staleDays} days old ahead of the ${when} hearing — ${evictionCase.unit.name}`,
          })
          flagged++
        }
      }
    }

    return { checked: cases.length, flagged }
  },
})
