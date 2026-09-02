import 'server-only'

import { agingTotals, balanceCents, delinquencyFor } from '@rental/core/ledger'
import { type CollectionMethod, debitsAutomatically } from '@rental/core/payments'
import type { AgingBucket } from '@rental/core/ledger'
import { businessDate, dueDateOnOrBefore, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { selectApplicableRule } from '@rental/core/jurisdiction'
import { leasesHalted } from '@/lib/holds/queries.ts'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// The rent roll and delinquency aging — the Monday-morning report (PAY-06,
// RPT-02, R-044).
//
// ==========================================================================
// ONE QUERY PASS FOR THE WHOLE PORTFOLIO, and it has to stay that way.
//
// The obvious build is a loop: for each lease, fetch its ledger, fetch its
// jurisdiction rule, fetch its last contact. At 50 units that is 200 round
// trips for a screen somebody opens every Monday at 6am, and it degrades
// exactly as the portfolio grows — the shape CLAUDE.md's own note about
// latency-bound work warns against.
//
// So: four bulk reads, grouped in memory. Jurisdiction rules in particular
// are read ONCE for the whole set of states involved and resolved per
// property from that, rather than `rulesFor()` per lease.
// ==========================================================================

export interface RentRollRow {
  leaseId: string
  propertyId: string
  propertyName: string
  unitName: string
  tenantName: string
  tenantId: string | null
  rentCents: number
  balanceCents: number
  daysLate: number
  bucket: AgingBucket
  /// Whether the STATUTORY grace period has elapsed — not the same as being
  /// in a late bucket. See `delinquencyFor`.
  pastGrace: boolean
  oldestDueOn: string | null
  /// True when the payer is on `charge_automatically` (D-29).
  autopay: boolean
  /// Deposit held as a liability (PAY-07). Shown because a lender asks, and
  /// because it is emphatically NOT money that can be applied to arrears
  /// mid-tenancy.
  depositHeldCents: number
  /// What a housing authority pays, where one does (D-13). Split out because
  /// "the tenant owes $1,500" and "the tenant owes $180 of a $1,500 rent" are
  /// different conversations.
  subsidyCents: number
  /// Last time anybody sent this tenant anything, property-local. Null means
  /// never — PAY-06 asks for it because chasing somebody nobody has spoken to
  /// is a different act from chasing somebody reminded twice this week.
  lastContactOn: string | null
  /// No jurisdiction rule configured for this property's state (D-4). Surfaced
  /// rather than silently treated as zero grace.
  graceUnknown: boolean
  /// A hold carrying `halt_dunning` is in force on this tenancy (R-084), so
  /// the chase is off. SEPARATE FROM `pastGrace` on purpose: the debt is
  /// still owed, still aged, still on the report. What stops is the asking.
  chaseHeld: boolean
}

export interface RentRoll {
  rows: RentRollRow[]
  totals: ReturnType<typeof agingTotals>
  billedCents: number
  outstandingCents: number
}

export async function rentRoll(scope: ResolvedScope, asOfDate?: Date): Promise<RentRoll> {
  const asOf = asOfDate ?? new Date()

  const leases = await prisma.lease.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
    },
    select: {
      id: true,
      propertyId: true,
      rentCents: true,
      rentDueDay: true,
      property: { select: { name: true, state: true, county: true, timezone: true } },
      unit: { select: { name: true } },
      leaseTenants: {
        select: { tenant: { select: { id: true, firstName: true, lastName: true } } },
      },
      leasePayers: {
        where: { active: true },
        select: { payerType: true, collectionMethod: true, portionCents: true, debitDay: true },
      },
      deposits: { select: { heldCents: true, appliedCents: true, refundedCents: true } },
    },
  })
  if (leases.length === 0) {
    return { rows: [], totals: agingTotals([]), billedCents: 0, outstandingCents: 0 }
  }

  const leaseIds = leases.map((lease) => lease.id)
  const tenantIds = leases.flatMap((lease) => lease.leaseTenants.map((lt) => lt.tenant.id))

  const [entries, charges, rules, contacts] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: { in: leaseIds } },
      select: {
        id: true,
        leaseId: true,
        type: true,
        amountCents: true,
        occurredAt: true,
        description: true,
        reversesId: true,
      },
    }),
    // Unwaived charges only. A waived late fee is not a debt, and leaving it
    // in would age a tenancy from a charge somebody deliberately forgave
    // (PAY-04).
    prisma.charge.findMany({
      where: { leaseId: { in: leaseIds }, waivedAt: null },
      select: { leaseId: true, dueOn: true, amountCents: true },
    }),
    // EVERY rule for EVERY state involved, in one read, resolved per property
    // below. `rulesFor()` per lease would be one query per row.
    prisma.jurisdictionRule.findMany({
      where: { state: { in: [...new Set(leases.map((l) => l.property.state))] } },
    }),
    // The most recent OUTBOUND message per tenant. Inbound does not count:
    // PAY-06 wants "when did we last contact them", and a tenant texting us
    // is not us contacting them.
    tenantIds.length > 0
      ? prisma.message.findMany({
          where: { thread: { tenantId: { in: tenantIds } }, direction: 'OUTBOUND' },
          select: { sentAt: true, thread: { select: { tenantId: true } } },
          orderBy: { sentAt: 'desc' },
        })
      : Promise.resolve([]),
  ])

  // R-084's `halt_dunning`, resolved for the WHOLE report rather than only
  // at send time. `pastGraceLeaseIds` has always subtracted these, so the
  // press was already refused — but the screen went on offering the
  // checkbox, counting the tenancy in "select all past grace", and giving no
  // reason in the row. This table's own header states the rule it broke: a
  // row that is not chaseable gets no control and a written reason instead
  // (Golden Path 5, D-134).
  const chaseHeldLeases = await leasesHalted(leaseIds, 'halt_dunning')

  const entriesByLease = groupBy(entries, (row) => row.leaseId)
  const chargesByLease = groupBy(charges, (row) => row.leaseId)

  const lastContact = new Map<string, Date>()
  for (const message of contacts) {
    const tenantId = message.thread?.tenantId
    // Ordered newest-first, so the FIRST one seen per tenant is the latest.
    if (tenantId && !lastContact.has(tenantId)) lastContact.set(tenantId, message.sentAt)
  }

  const rows: RentRollRow[] = leases.map((lease) => {
    const zone = lease.property.timezone
    const rule = selectApplicableRule(
      rules.filter((r) => r.state === lease.property.state),
      lease.property.county,
      asOf,
    )

    const ledger = entriesByLease.get(lease.id) ?? []
    const balance = balanceCents(ledger)
    const today = businessDate(asOf, zone)
    // The payer's CHOSEN day when they have one, the lease's day when they
    // do not - the same precedence `predebit.ts` reads (R-039a). Ordinary
    // rent mints no Charge row (D-11/D-40), so this is the only record of
    // when it was due at all.
    const rentDueDay = lease.leasePayers[0]?.debitDay ?? lease.rentDueDay

    const delinquency = delinquencyFor({
      charges: (chargesByLease.get(lease.id) ?? []).map((charge) => ({
        // `@db.Date`. `utcToBusinessDate` is the reader for a calendar day;
        // putting one through a timezone is the R-042 bug in a new place.
        dueOn: utcToBusinessDate(charge.dueOn),
        amountCents: charge.amountCents,
      })),
      balanceCents: balance,
      // The PROPERTY's today, not the server's (D-3). A portfolio spanning
      // timezones has more than one "today", and using the server's would
      // report a Texas tenancy late from a machine in Europe.
      asOf: today,
      graceDays: rule?.graceDays ?? null,
      nearestRentDueOn: dueDateOnOrBefore(today, rentDueDay),
      // The size of the rent debt those charges sit behind (R-118). Without
      // it every balance is attributed to the oldest charge row on file,
      // paid or not.
      monthlyRentCents: lease.rentCents,
    })

    const tenant = lease.leaseTenants[0]?.tenant ?? null
    // `portionCents` is what this payer is billed, set per payer by D-13's
    // two-customers-one-lease shape. Summed rather than assumed single: a
    // lease can carry more than one non-tenant payer.
    const subsidy = lease.leasePayers
      .filter((payer) => payer.payerType === 'HOUSING_AUTHORITY')
      .reduce((sum, payer) => sum + (payer.portionCents ?? 0), 0)

    return {
      leaseId: lease.id,
      propertyId: lease.propertyId,
      propertyName: lease.property.name,
      unitName: lease.unit.name,
      tenantName: tenant ? `${tenant.firstName} ${tenant.lastName}` : '—',
      tenantId: tenant?.id ?? null,
      rentCents: lease.rentCents,
      balanceCents: delinquency.balanceCents,
      daysLate: delinquency.daysLate,
      bucket: delinquency.bucket,
      pastGrace: delinquency.pastGrace,
      oldestDueOn: delinquency.oldestDueOn,
      // Any active payer on autopay counts: what the question is really
      // asking is "will money arrive without somebody chasing it".
      autopay: lease.leasePayers.some((payer) => debitsAutomatically(payer.collectionMethod as CollectionMethod)),
      // Held, less what has been applied or refunded — the LIABILITY still
      // owed back, which is the number PAY-07 says must never be mixed with
      // income and the number a lender is asking for.
      depositHeldCents: lease.deposits.reduce(
        (sum, deposit) => sum + deposit.heldCents - deposit.appliedCents - deposit.refundedCents,
        0,
      ),
      subsidyCents: subsidy,
      lastContactOn: tenant && lastContact.has(tenant.id)
        ? businessDate(lastContact.get(tenant.id)!, zone)
        : null,
      graceUnknown: rule == null,
      chaseHeld: chaseHeldLeases.has(lease.id),
    }
  })

  // Worst first. The report exists to be acted on from the top, and sorting
  // by property name would bury a 90-day arrear under an alphabet.
  rows.sort((a, b) => b.daysLate - a.daysLate || b.balanceCents - a.balanceCents)

  return {
    rows,
    totals: agingTotals(rows),
    billedCents: rows.reduce((sum, row) => sum + row.rentCents, 0),
    outstandingCents: rows.reduce((sum, row) => sum + Math.max(0, row.balanceCents), 0),
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const existing = map.get(k)
    if (existing) existing.push(row)
    else map.set(k, [row])
  }
  return map
}

/**
 * Which of these leases are genuinely past their statutory grace period.
 *
 * ==========================================================================
 * THE SERVER-SIDE RE-CHECK FOR THE BULK REMINDER (R-044).
 *
 * The rent-roll screen builds its selection from `pastGrace`, but a checkbox
 * is an affordance and nothing more. Between the page rendering and the
 * button being pressed a tenant can pay, and a stale page or a crafted post
 * can name any lease at all — so the set is recomputed here, from the same
 * `delinquencyFor` the screen used, immediately before anything is sent.
 *
 * Chasing a tenant who is still inside the grace period their state grants
 * them is the exposure this whole item is shaped around. It is not a thing to
 * leave to the browser.
 *
 * R-084 ADDS THE SECOND REASON A LEASE MAY NOT BE CHASED, and puts it here
 * rather than in `sendReminders` deliberately: this function is what the
 * comment above calls "immediately before anything is sent", so a hold placed
 * while the screen was open stops the message the same way a payment made
 * while the screen was open does. Under an automatic stay, sending the chase
 * is itself the violation — there is no version of it that is only a bit
 * wrong.
 * ==========================================================================
 */
export async function pastGraceLeaseIds(
  leaseIds: readonly string[],
  asOfDate?: Date,
): Promise<Set<string>> {
  if (leaseIds.length === 0) return new Set()
  const asOf = asOfDate ?? new Date()

  const leases = await prisma.lease.findMany({
    where: { id: { in: [...leaseIds] } },
    select: {
      id: true,
      rentDueDay: true,
      // R-118: the anchor is allocated from the balance, so the rent figure
      // is part of the re-check and not only of the screen.
      rentCents: true,
      property: { select: { state: true, county: true, timezone: true } },
      leasePayers: { where: { active: true }, select: { debitDay: true } },
    },
  })

  const [entries, charges, rules] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: { in: [...leaseIds] } },
      select: {
        id: true,
        leaseId: true,
        type: true,
        amountCents: true,
        occurredAt: true,
        description: true,
        reversesId: true,
      },
    }),
    prisma.charge.findMany({
      where: { leaseId: { in: [...leaseIds] }, waivedAt: null },
      select: { leaseId: true, dueOn: true, amountCents: true },
    }),
    prisma.jurisdictionRule.findMany({
      where: { state: { in: [...new Set(leases.map((l) => l.property.state))] } },
    }),
  ])

  const entriesByLease = groupBy(entries, (row) => row.leaseId)
  const chargesByLease = groupBy(charges, (row) => row.leaseId)

  const allowed = new Set<string>()
  for (const lease of leases) {
    const rule = selectApplicableRule(
      rules.filter((r) => r.state === lease.property.state),
      lease.property.county,
      asOf,
    )
    const today = businessDate(asOf, lease.property.timezone)
    const rentDueDay = lease.leasePayers[0]?.debitDay ?? lease.rentDueDay
    const delinquency = delinquencyFor({
      charges: (chargesByLease.get(lease.id) ?? []).map((charge) => ({
        dueOn: utcToBusinessDate(charge.dueOn),
        amountCents: charge.amountCents,
      })),
      balanceCents: balanceCents(entriesByLease.get(lease.id) ?? []),
      asOf: today,
      graceDays: rule?.graceDays ?? null,
      nearestRentDueOn: dueDateOnOrBefore(today, rentDueDay),
      monthlyRentCents: lease.rentCents,
    })
    if (delinquency.pastGrace) allowed.add(lease.id)
  }

  // R-084. Asks for the EFFECT, not for a hold type — see
  // lib/holds/queries.ts's own header for why no guard in this app names a
  // type.
  const held = await leasesHalted([...allowed], 'halt_dunning')
  for (const leaseId of held) allowed.delete(leaseId)

  return allowed
}
