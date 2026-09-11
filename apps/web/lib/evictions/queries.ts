import 'server-only'

import {
  CURE_NOTICE_TYPES,
  cureClock,
  cureDemand,
  cureVerdict,
  demandKind,
  paymentsSinceService,
  type CurePayment,
  type DemandLine,
  type ServiceEvent,
} from '@rental/core/evictions'
import { balanceCents } from '@rental/core/ledger'
import {
  businessDate,
  type DayCountRule,
  dueDateOnOrBefore,
  UNREVIEWED_DAY_COUNT,
  utcToBusinessDate,
} from '@rental/core/scheduling'
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
  // R-156. Same D-48 posture as the cure period: null means this product has
  // not been taught whether this state treats acceptance as waiver, and the
  // case page then warns conservatively rather than answering for the state.
  let acceptanceWaivesNotice: boolean | null = null
  let acceptanceWaiverNote: string | null = null
  // R-194. Three-valued like the two above; shown only beside a part-cured
  // verdict.
  let partialPaymentCures: boolean | null = null
  // R-182: how the state counts the cure period, not just how many days it
  // is. An unconfigured state has neither, and `UNREVIEWED_DAY_COUNT` is what
  // that absence looks like - `cureClock` reports no deadline at all there.
  let dayCount: DayCountRule = UNREVIEWED_DAY_COUNT
  try {
    const rule = await rulesFor(evictionCase.property, new Date())
    payOrQuitDays = rule.payOrQuitDays
    acceptanceWaivesNotice = rule.acceptanceWaivesNotice
    acceptanceWaiverNote = rule.acceptanceWaiverNote
    partialPaymentCures = rule.partialPaymentCures
    dayCount = rule
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
        // `servedAt` is a real timestamp, so the property-local reader -
        // `utcToBusinessDate` here (fixed at R-156) put a 9pm Chicago
        // service on the NEXT calendar day, starting the cure clock a day
        // late and hiding a same-evening payment from the acceptance band.
        servedOn: businessDate(delivery.servedAt, evictionCase.property.timezone),
        permittedByJurisdiction: delivery.permittedByJurisdiction,
      })),
    )

  const hasNotice = evictionCase.notices.some((notice) => CURE_NOTICE_TYPES.includes(notice.type))
  const today = businessDate(new Date(), evictionCase.property.timezone)

  // R-156: the money that may have waived the notice. Every rail lands here -
  // portal ACH, an autopay retry, cash at the counter - because the webhook
  // and the offline recorder both mint a `Payment` row. A reversed or failed
  // payment was not KEPT, and acceptance is about keeping the money.
  const paymentRows = await prisma.payment.findMany({
    where: {
      leaseId: evictionCase.leaseId,
      status: { in: ['PENDING', 'SETTLED'] },
      reversedAt: null,
    },
    orderBy: { receivedAt: 'asc' },
    select: { amountCents: true, receivedAt: true, channel: true },
  })
  const payments: CurePayment[] = paymentRows.map((p) => ({
    receivedOn: businessDate(p.receivedAt, evictionCase.property.timezone),
    amountCents: p.amountCents,
    channelLabel: PAYMENT_CHANNEL_LABELS[p.channel] ?? p.channel,
  }))

  const clock = cureClock(services, payOrQuitDays, today, dayCount)

  // R-194: the notice whose demand the verdict is read against - the one
  // holding the service the clock runs from, so a second notice drafted after
  // a defective first one is judged on its own demand. Before any good
  // service, the earliest drafted.
  const cureNotices = evictionCase.notices.filter((notice) => CURE_NOTICE_TYPES.includes(notice.type))
  const demandNotice =
    cureNotices.find((notice) =>
      notice.deliveries.some(
        (delivery) =>
          delivery.permittedByJurisdiction !== false &&
          businessDate(delivery.servedAt, evictionCase.property.timezone) === clock.runsFrom,
      ),
    ) ??
    cureNotices[0] ??
    null

  return {
    clock,
    hasNotice,
    paymentsSinceService: paymentsSinceService(services, payments),
    acceptanceWaivesNotice,
    acceptanceWaiverNote,
    partialPaymentCures,
    demand: demandNotice
      ? {
          noticeId: demandNotice.id,
          // Our own write, validated by the drafting action and frozen by
          // R-161's trigger - read back as the shape it was written in.
          lines: (demandNotice.demandComposition as DemandLine[] | null) ?? [],
          verdict: cureVerdict(
            demandNotice.demandedCents,
            payments,
            businessDate(demandNotice.generatedAt, evictionCase.property.timezone),
            clock.cureBy,
          ),
        }
      : null,
  }
}

/**
 * What a cure notice drafted on this case today would demand (R-194). Read by
 * the case page to preview it and by `draftCureNotice` to store it, so the
 * figure shown before the press is the figure computed at it.
 *
 * The facts are the rent roll's own: ledger balance, unwaived charges, and
 * the current period's rent dated by the payer's debit day or the lease's due
 * day - the same precedence `rentRoll` reads.
 */
export async function cureDemandFor(evictionCase: EvictionCaseDetail) {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: evictionCase.leaseId },
    select: {
      rentCents: true,
      rentDueDay: true,
      leasePayers: { where: { active: true }, select: { debitDay: true }, take: 1 },
      ledgerEntries: {
        select: { id: true, type: true, amountCents: true, occurredAt: true, description: true, reversesId: true },
      },
      charges: {
        where: { waivedAt: null },
        select: { type: true, description: true, dueOn: true, amountCents: true },
      },
    },
  })

  // Same resolver and same "no rule is not an error" posture as
  // `cureClockFor`: an unconfigured state has an unreviewed fee rule and an
  // unknown cure period, both of which the caller states rather than guesses.
  let rule: { id: string; payOrQuitDays: number | null; cureDemandMayIncludeFees: boolean | null } | null = null
  try {
    rule = await rulesFor(evictionCase.property, new Date())
  } catch {
    rule = null
  }

  const today = businessDate(new Date(), evictionCase.property.timezone)
  const rentDueDay = lease.leasePayers[0]?.debitDay ?? lease.rentDueDay
  const mayIncludeFees = rule?.cureDemandMayIncludeFees ?? null

  return {
    demand: cureDemand({
      balanceCents: balanceCents(lease.ledgerEntries),
      debts: [
        ...lease.charges.map((charge) => ({
          // `@db.Date` - the calendar-day reader, never a zone (R-042).
          dueOn: utcToBusinessDate(charge.dueOn),
          amountCents: charge.amountCents,
          label: charge.description,
          kind: demandKind(charge.type),
        })),
        {
          dueOn: dueDateOnOrBefore(today, rentDueDay),
          amountCents: lease.rentCents,
          label: 'Rent',
          kind: 'RENT' as const,
        },
      ],
      mayIncludeFees,
    }),
    mayIncludeFees,
    payOrQuitDays: rule?.payOrQuitDays ?? null,
    jurisdictionRuleId: rule?.id ?? null,
  }
}

/// Display names for every rail a `Payment` can carry. The acceptance band
/// and the packet quote these verbatim; nothing branches on them.
const PAYMENT_CHANNEL_LABELS: Record<string, string> = {
  ACH: 'ACH',
  CARD: 'Card',
  RETAIL_CASH: 'Retail cash network',
  OFFLINE_CHECK: 'Check at the counter',
  MONEY_ORDER: 'Money order',
  OFFLINE_CASH: 'Cash at the counter',
  HAP_ACH: 'Housing-authority ACH',
  OTHER: 'Payment provider',
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
