import 'server-only'

import { CURE_NOTICE_TYPES, cureClock, type ServiceEvent } from '@rental/core/evictions'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for eviction case files (PAY-14, R-083). Scoped by ResolvedScope,
// the same pattern every other staff query in this product uses.

const caseInclude = {
  property: {
    select: {
      id: true,
      name: true,
      timezone: true,
      addressLine1: true,
      state: true,
      county: true,
      // propertyResource() needs this to build the RBAC resource.
      legalEntityId: true,
    },
  },
  unit: { select: { id: true, name: true } },
  lease: {
    select: {
      id: true,
      leaseTenants: {
        orderBy: { isPrimary: 'desc' as const },
        // `id` too, since R-085: a §3931 search is run against a NAMED
        // defendant, so the case page has to be able to say which person it
        // is recording a result for.
        select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  },
  openedBy: { select: { id: true, name: true } },
  costs: { orderBy: { incurredOn: 'asc' as const } },
  notices: {
    orderBy: { generatedAt: 'asc' as const },
    include: { deliveries: { orderBy: { servedAt: 'asc' as const } } },
  },
} as const

export async function listEvictionCases(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.evictionCase.findMany({
    where: { propertyId: { in: [...scope.propertyIds] } },
    orderBy: [{ closedAt: 'asc' }, { openedAt: 'desc' }],
    include: caseInclude,
  })
}

export async function getEvictionCase(id: string, scope: ResolvedScope) {
  const found = await prisma.evictionCase.findUnique({ where: { id }, include: caseInclude })
  // 404 rather than 403 for a record outside scope (ROLE-01) - the caller
  // calls notFound(), so "forbidden" can never be used to confirm a case
  // exists for a property you cannot see.
  if (!found || !scope.propertyIds.includes(found.propertyId)) return null
  return found
}

export type EvictionCaseDetail = NonNullable<Awaited<ReturnType<typeof getEvictionCase>>>

/**
 * The cure clock for a case, read from the cure-starting notices filed under
 * it and the jurisdiction's own configured period.
 *
 * The jurisdiction rule is resolved the same way every other legal lookup in
 * this product resolves one, and `payOrQuitDays` may be null - meaning this
 * product has not been taught this state's cure period, which
 * `cureClock` reports rather than guesses.
 */
export async function cureClockFor(evictionCase: EvictionCaseDetail) {
  // `rulesFor` is the resolver, never `prisma.jurisdictionRule` directly -
  // its own doc comment makes that the rule for every consumer needing a
  // notice period. It THROWS when a state has no rule at all, which for this
  // caller is not an error: an unconfigured state means the cure period is
  // unknown, and `cureClock` reports that rather than guessing a number.
  let payOrQuitDays: number | null = null
  try {
    payOrQuitDays = (await rulesFor(evictionCase.property, new Date())).payOrQuitDays
  } catch {
    payOrQuitDays = null
  }

  // `CURE_NOTICE_TYPES` is the one list, shared with `attachableNotices`
  // below (D-148). It used to read PAY_OR_QUIT alone while the picker offered
  // both, so a case holding a served Texas notice to vacate reported "Notice
  // not yet served" and could never be filed.
  const services: ServiceEvent[] = evictionCase.notices
    .filter((notice) => CURE_NOTICE_TYPES.includes(notice.type))
    .flatMap((notice) =>
      notice.deliveries.map((delivery) => ({
        servedOn: utcToBusinessDate(delivery.servedAt),
        permittedByJurisdiction: delivery.permittedByJurisdiction,
      })),
    )

  const hasNotice = evictionCase.notices.some((notice) => CURE_NOTICE_TYPES.includes(notice.type))
  const today = businessDate(new Date(), evictionCase.property.timezone)

  return { clock: cureClock(services, payOrQuitDays, today), hasNotice }
}

/// Notices on this lease that could start a cure period and are not yet filed
/// under any case - what the "attach a notice" picker offers. The types come
/// from `CURE_NOTICE_TYPES` rather than a literal, because a type this picker
/// offers and the cure clock ignores is a case that can never be filed
/// (D-148).
///
/// A notice already attached to another case is deliberately absent: one served notice belongs to one
/// case, and the same notice supporting two filings is not evidence.
export async function attachableNotices(leaseId: string) {
  return prisma.notice.findMany({
    where: { leaseId, evictionCaseId: null, type: { in: [...CURE_NOTICE_TYPES] } },
    orderBy: { generatedAt: 'desc' },
    select: { id: true, type: true, generatedAt: true, servedAt: true },
  })
}

/// Active leases in scope with no open eviction case - the "open a case"
/// picker. A second open case on one lease would be two files telling
/// different stories about the same tenancy.
export async function leasesWithoutOpenCase(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.lease.findMany({
    where: {
      propertyId: { in: [...scope.propertyIds] },
      status: 'ACTIVE',
      evictionCases: { none: { stage: { not: 'CLOSED' } } },
    },
    orderBy: [{ property: { name: 'asc' } }, { unit: { name: 'asc' } }],
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      property: { select: { name: true } },
      unit: { select: { name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  })
}
