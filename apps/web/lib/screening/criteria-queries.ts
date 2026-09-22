import 'server-only'

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
export async function listCriteriaVersions(): Promise<ScreeningCriteria[]> {
  return prisma.screeningCriteria.findMany({
    orderBy: { version: 'desc' },
  })
}

export async function currentCriteriaVersion(): Promise<ScreeningCriteria | null> {
  return prisma.screeningCriteria.findFirst({
    where: { effectiveTo: null },
    orderBy: { version: 'desc' },
  })
}
