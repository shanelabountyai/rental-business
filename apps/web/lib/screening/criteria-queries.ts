import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import type { Decision, DecisionRow, Quarter } from '@rental/core/screening'
import { type ScreeningCriteria, prisma } from '@rental/db'

// The admin side of R-242 (OQ-6): reading ScreeningCriteria versions.
// `order.ts`'s `currentScreeningCriteria` already owns the resolver every
// screening flow calls - this is only the extra reads a version-history
// screen needs, the same split jurisdiction/queries.ts draws between
// `rulesFor` and its own `listRuleVersions`.

/// Every version ever recorded, newest first - the audit trail a
/// version-only entity needs instead of a separate history page, since old
/// versions are never edited or deleted (same posture JurisdictionRule's D-4
/// already established).
/// R-297: each org's versions are its own sequence.
export async function listCriteriaVersions(orgId: string): Promise<ScreeningCriteria[]> {
  return prisma.screeningCriteria.findMany({
    where: { orgId },
    orderBy: { version: 'desc' },
  })
}

export async function currentCriteriaVersion(orgId: string): Promise<ScreeningCriteria | null> {
  return prisma.screeningCriteria.findFirst({
    where: { orgId, effectiveTo: null },
    orderBy: { version: 'desc' },
  })
}

/// The org's whole reason list, retired rows included, for the editor.
export async function listDecisionReasons(orgId: string) {
  return prisma.decisionReason.findMany({
    where: { orgId },
    orderBy: [{ retiredAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'asc' }],
  })
}

/**
 * Every decision recorded in the org in `quarter`, bucketed by the
 * decision's day in the property's own zone. The UTC window is a day wider
 * on each side so no zone falls off an edge; the filter on the local day is
 * what decides.
 */
export async function decisionsInQuarter(orgId: string, quarter: Quarter): Promise<DecisionRow[]> {
  const from = new Date(`${quarter.from}T00:00:00.000Z`)
  const to = new Date(`${quarter.to}T00:00:00.000Z`)
  from.setUTCDate(from.getUTCDate() - 1)
  to.setUTCDate(to.getUTCDate() + 1)
  const reports = await prisma.screeningReport.findMany({
    where: { orgId, decision: { not: null }, decidedAt: { gte: from, lt: to } },
    select: {
      decision: true,
      decidedAt: true,
      decisionReasonCode: true,
      decisionReason: { select: { label: true } },
      applicant: {
        select: {
          application: {
            select: { completedAt: true, property: { select: { name: true, timezone: true } } },
          },
        },
      },
    },
    orderBy: { decidedAt: 'asc' },
  })
  return reports
    .map((r) => {
      const { property, completedAt } = r.applicant.application
      return {
        // `decision: { not: null }` above; the column is the three DECISIONS.
        decision: r.decision as Decision,
        reasonCode: r.decisionReasonCode,
        reasonLabel: r.decisionReason?.label ?? null,
        propertyName: property.name,
        completedOn: completedAt ? businessDate(completedAt, property.timezone) : null,
        decidedOn: businessDate(r.decidedAt!, property.timezone),
      }
    })
    .filter((row) => row.decidedOn >= quarter.from && row.decidedOn < quarter.to)
}
