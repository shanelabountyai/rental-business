import 'server-only'

import { prisma } from '@rental/db'

// R-298a (PRD 10 §7.2, D-389): the states an org operates in. The rules stay
// org-less (`queries.ts`, D-4); this is only whether the org may act in a
// state, and whether its own counsel has reviewed it.

export function orgStates(orgId: string) {
  return prisma.orgJurisdiction.findMany({ where: { orgId }, orderBy: { state: 'asc' } })
}

/// The refusal for a property in a state the org has not enabled, or null.
export async function stateNotEnabled(orgId: string, state: string): Promise<string | null> {
  const row = await prisma.orgJurisdiction.findUnique({
    where: { orgId_state: { orgId, state } },
    select: { id: true },
  })
  return row ? null : `${state} is not enabled for your organisation. An owner enables it on the Jurisdiction rules page.`
}

/// True until the org records its counsel's review of `state`. A state that
/// is not enabled at all is unreviewed too.
export async function counselUnreviewed(orgId: string, state: string): Promise<boolean> {
  const row = await prisma.orgJurisdiction.findUnique({
    where: { orgId_state: { orgId, state } },
    select: { counselReviewedAt: true },
  })
  return !row?.counselReviewedAt
}
