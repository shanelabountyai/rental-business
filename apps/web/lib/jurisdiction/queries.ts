import 'server-only'

import { selectApplicableRule } from '@rental/core/jurisdiction'
import { type JurisdictionRule, prisma } from '@rental/db'

// The database side of R-010. packages/core/jurisdiction decides which row
// governs; this fetches the candidates and is the one place anything reads a
// JurisdictionRule from (D-4: "nothing anywhere reads a statutory number any
// other way").

/// Thrown by `rulesFor` when a state has no configuration at all - a real gap
/// (OQ-1: only the footprint states are seeded), not a bug. Left uncaught, it
/// fails loudly instead of a caller silently treating "no rule" as "no fees,
/// no notice requirements", which is exactly the kind of compliance failure
/// D-4 exists to prevent.
export class JurisdictionRuleNotFoundError extends Error {
  readonly state: string

  constructor(state: string) {
    super(
      `No jurisdiction rule configured for ${state}. Add one at /jurisdiction before this property can compute fees, deposits or notices.`,
    )
    this.name = 'JurisdictionRuleNotFoundError'
    this.state = state
  }
}

/**
 * The resolver the backlog names: `rulesFor(property, asOf)`. Every later
 * item that needs a grace period, a late-fee cap, a deposit deadline or a
 * notice period calls this - never `prisma.jurisdictionRule` directly, and
 * never a literal number.
 */
export async function rulesFor(
  property: { state: string; county?: string | null },
  asOf: Date,
): Promise<JurisdictionRule> {
  const candidates = await prisma.jurisdictionRule.findMany({
    where: { state: property.state },
  })
  const rule = selectApplicableRule(candidates, property.county, asOf)
  if (!rule) throw new JurisdictionRuleNotFoundError(property.state)
  return rule
}

/// One row per configured (state, jurisdiction) pair - whichever version is
/// in force on `asOf`. Powers the admin list; not exercised by any other
/// consumer, so it stays a plain JS group-by rather than a query built for a
/// row count this small ever needs.
export async function listCurrentRules(
  asOf: Date,
): Promise<JurisdictionRule[]> {
  const rows = await prisma.jurisdictionRule.findMany({
    orderBy: [{ state: 'asc' }, { jurisdiction: 'asc' }, { effectiveFrom: 'desc' }],
  })

  const groups = new Map<string, JurisdictionRule[]>()
  for (const row of rows) {
    const key = `${row.state}::${row.jurisdiction ?? ''}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const current: JurisdictionRule[] = []
  for (const group of groups.values()) {
    const active = group.find(
      (row) =>
        row.effectiveFrom <= asOf &&
        (row.effectiveTo == null || asOf <= row.effectiveTo),
    )
    if (active) current.push(active)
  }
  return current
}

/// Every version ever recorded for one (state, jurisdiction) pair, newest
/// first - the audit trail a version-only entity needs instead of a separate
/// history page, since old versions are never edited or deleted (D-4).
export async function listRuleVersions(
  state: string,
  jurisdiction: string | null,
): Promise<JurisdictionRule[]> {
  return prisma.jurisdictionRule.findMany({
    where: { state, jurisdiction },
    orderBy: { version: 'desc' },
  })
}

export async function currentRuleVersion(
  state: string,
  jurisdiction: string | null,
): Promise<JurisdictionRule | null> {
  return prisma.jurisdictionRule.findFirst({
    where: { state, jurisdiction, effectiveTo: null },
    orderBy: { version: 'desc' },
  })
}
