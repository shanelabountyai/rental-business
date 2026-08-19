import 'server-only'

import { balanceCents } from '@rental/core/ledger'
import { fundsCleared } from '@rental/core/payments'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'

// Populates the `Deposit` liability the moment move-in funds actually clear
// (INSP-01, R-069) - the half `chargeDeposit()`'s own comment left standing
// for this item: "a liability that becomes real once payment clears".
//
// PULL, NOT PUSH. A Stripe webhook fires the instant a payment SETTLES, but
// for an `OFFLINE_CHECK` that only means "handed over" - `fundsCleared()`
// (packages/core/payments/clearing.ts) turns true CHECK_HOLD_DAYS later
// with no new event marking that moment. So this runs daily, like every
// other window-watching job in this file, and asks whether a fact has
// become true since yesterday.
//
// ONLY THE DEPOSIT, not first month's rent too. `chargeDeposit()`'s own
// comment ties "move-in funds show cleared" specifically to the deposit
// charge, and that is the scope this item keeps - see D-59.
//
// A CREDIT alone never satisfies this. `balanceCents() <= 0` can go true
// from a waiver as well as a real payment; `settlingPayments` below only
// counts entries that actually carry a `Payment`, so a credited deposit -
// no real cash ever collected - never creates a `Deposit` row, which is the
// correct outcome: there is no liability to record.
const LOCAL_HOUR = 3

SCHEDULED_JOBS.push({
  type: 'lease.deposit_cleared',
  localHour: LOCAL_HOUR,
  description:
    "Creates the Deposit liability record once a lease's deposit charge is fully paid with funds safe to act on, and flags staff to release access codes (R-069).",
  run: async ({ propertyId, businessDate: today }) => {
    const asOf = new Date(`${today}T23:59:59.999Z`)

    const leases = await prisma.lease.findMany({
      where: {
        propertyId,
        depositArrangement: 'CASH',
        depositCents: { gt: 0 },
        deposits: { none: {} },
      },
      select: {
        id: true,
        propertyId: true,
        depositCents: true,
        unit: { select: { name: true } },
        charges: { where: { type: 'DEPOSIT' }, select: { id: true }, take: 1 },
      },
    })

    let cleared = 0
    for (const lease of leases) {
      const charge = lease.charges[0]
      if (!charge) continue

      const entries = await prisma.ledgerEntry.findMany({
        where: { chargeId: charge.id },
        select: {
          id: true,
          amountCents: true,
          occurredAt: true,
          description: true,
          payment: { select: { channel: true, status: true, receivedAt: true } },
        },
      })
      if (entries.length === 0) continue
      const rows = entries.map((e) => ({
        id: e.id,
        type: '',
        amountCents: e.amountCents,
        occurredAt: e.occurredAt,
        description: e.description,
      }))
      if (balanceCents(rows) > 0) continue

      type Entry = (typeof entries)[number]
      type EntryWithPayment = Entry & { payment: NonNullable<Entry['payment']> }
      const settlingPayments = entries.filter(
        (e): e is EntryWithPayment => e.amountCents < 0 && e.payment !== null,
      )
      const allCleared =
        settlingPayments.length > 0 &&
        settlingPayments.every((e) => fundsCleared(e.payment, asOf))
      if (!allCleared) continue

      const receivedAt = settlingPayments
        .map((e) => e.payment.receivedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0]!

      await prisma.$transaction(async (tx) => {
        await tx.deposit.create({
          data: {
            propertyId: lease.propertyId,
            leaseId: lease.id,
            heldCents: lease.depositCents,
            receivedAt,
          },
        })
        await createTask(tx, {
          propertyId: lease.propertyId,
          type: 'lease.deposit_cleared',
          subjectType: 'Lease',
          subjectId: lease.id,
          businessDate: today,
          priority: 'ROUTINE',
          title: `Move-in funds cleared — release access codes (${lease.unit.name})`,
        })
      })
      cleared++
    }

    return { checked: leases.length, cleared }
  },
})
