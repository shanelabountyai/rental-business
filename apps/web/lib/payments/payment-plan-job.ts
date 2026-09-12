import 'server-only'

import { formatCents } from '@rental/core/money'
import { planProgress } from '@rental/core/payments'
import {
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { voidPlanEnvelope } from '@/lib/payments/plan-envelope.ts'
import { paidTowardPlan } from '@/lib/payments/plans.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The break condition (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// THIS IS WHAT MAKES A PLAN A PLAN RATHER THAN A NOTE.
//
// A repayment agreement used to be a hold with a sentence in it. Nothing
// noticed when the tenant stopped paying, so the chase and the late-fee
// meter stayed off - sometimes for months - against a tenancy that had not
// kept a single instalment. The plan's own hold was, in effect, permanent
// amnesty that nobody had decided to grant.
//
// So every property-local day this asks each live plan the one question:
// has the money that should have arrived actually arrived? A plan that has
// fallen behind is BROKEN, its hold comes off, and a Task says so. A plan
// that has been paid in full is COMPLETED, and its hold comes off too - with
// its own Task, because dunning silently resuming against somebody who did
// everything they agreed to is exactly the surprise this product should not
// spring.
// ==========================================================================
//
// PULL, NOT PUSH, like every other window-watching job here: nothing fires
// when an instalment is missed, a day simply has to pass.
//
// Runs at 06:00 local, AFTER the 05:00 deposit reminders and before anybody
// opens the rent roll - so a plan that broke overnight is already broken by
// the time the Monday-morning screen is read, rather than showing a tenancy
// as protected that no longer is.
const LOCAL_HOUR = 6

SCHEDULED_JOBS.push({
  type: 'payment_plan.check',
  localHour: LOCAL_HOUR,
  description:
    'Breaks a repayment plan whose instalment went unpaid, completes one that is paid off, and lifts the hold either way (PAY-08).',
  run: async ({ propertyId, timezone, businessDate: today }) => {
    const plans = await prisma.paymentPlan.findMany({
      where: { propertyId, status: 'ACTIVE' },
      select: {
        id: true,
        leaseId: true,
        startedOn: true,
        instalments: { select: { dueOn: true, amountCents: true } },
        hold: { select: { id: true, liftedAt: true } },
        lease: { select: { unit: { select: { name: true } } } },
      },
    })
    if (plans.length === 0) return { checked: 0, broken: 0, completed: 0 }

    // ONE READ FOR EVERY PLAN ON THE PROPERTY, not one per plan. A property
    // has a handful of plans at most, but the ledger read is the expensive
    // half and the same shape the rent roll already uses.
    const entries = await prisma.ledgerEntry.findMany({
      where: { leaseId: { in: plans.map((plan) => plan.leaseId) } },
      select: { leaseId: true, type: true, amountCents: true, occurredAt: true },
    })

    let broken = 0
    let completed = 0

    for (const plan of plans) {
      const startedOn = utcToBusinessDate(plan.startedOn)
      const progress = planProgress({
        instalments: plan.instalments.map((row) => ({
          dueOn: utcToBusinessDate(row.dueOn),
          amountCents: row.amountCents,
        })),
        paidCents: paidTowardPlan(
          entries.filter((entry) => entry.leaseId === plan.leaseId),
          startedOn,
          timezone,
        ),
        asOf: today,
      })

      if (progress.status === 'ACTIVE') continue

      const ended = progress.status === 'BROKEN' ? 'BROKEN' : 'COMPLETED'
      const liftReason =
        ended === 'BROKEN'
          ? `Payment plan broken — the instalment due ${friendlyBusinessDate(progress.missedDueOn!)} is ${formatCents(progress.shortfallCents)} short.`
          : 'Payment plan paid in full.'

      await prisma.$transaction(async (tx) => {
        await tx.paymentPlan.update({
          where: { id: plan.id },
          data:
            ended === 'BROKEN'
              ? {
                  status: 'BROKEN',
                  brokenAt: new Date(),
                  // The instalment it broke ON, not today. "You missed the
                  // April payment" is the sentence; "the system noticed on
                  // the 7th of May" is not.
                  brokenOn: businessDateToUtc(progress.missedDueOn!),
                }
              : { status: 'COMPLETED', completedAt: new Date() },
        })
        // `liftedBySystem`, NOT `liftedByStaffId`. Nobody decided this - an
        // instalment date passed - and attributing it to whoever agreed the
        // plan would be a false fact on the one row an eviction is argued
        // from. R-084's check constraint still holds: a lifted hold always
        // names who lifted it and why, and the answer here is this job.
        if (plan.hold && plan.hold.liftedAt === null) {
          await tx.leaseHold.update({
            where: { id: plan.hold.id },
            data: { liftedAt: new Date(), liftedBySystem: 'job:payment_plan.check', liftReason },
          })
        }
      })

      // R-203: a BROKEN plan withdraws an agreement still out for signature.
      // A COMPLETED one does not - the tenant kept to it, and an executed
      // agreement is never voided in any case (see `voidPlanEnvelope`).
      //
      // Outside the transaction above, because it calls the provider; its
      // outcome lands in this plan's own audit row below rather than a
      // second entry.
      const voidedEnvelopeId =
        ended === 'BROKEN' ? await voidPlanEnvelope(plan.id, liftReason) : null

      await createTask(prisma, {
        propertyId,
        type: ended === 'BROKEN' ? 'payment_plan.broken' : 'payment_plan.completed',
        subjectType: 'Lease',
        subjectId: plan.leaseId,
        businessDate: today,
        // A broken plan is usually the last step before a notice, and the
        // window to act on it is short. A completed one is good news that
        // still needs somebody to know the chase is back on.
        priority: ended === 'BROKEN' ? 'URGENT' : 'ROUTINE',
        title:
          ended === 'BROKEN'
            ? `Payment plan broken (${formatCents(progress.shortfallCents)} short since ${friendlyBusinessDate(progress.missedDueOn!)}) — ${plan.lease.unit.name}`
            : `Payment plan paid in full — ${plan.lease.unit.name}`,
      })

      await auditAsSystem('job:payment_plan.check', {
        action:
          ended === 'BROKEN' ? 'lease.payment_plan_broken' : 'lease.payment_plan_completed',
        entityType: 'Lease',
        entityId: plan.leaseId,
        propertyId,
        reason: liftReason,
        after: {
          planId: plan.id,
          outcome: ended,
          paidCents: progress.paidCents,
          dueToDateCents: progress.dueToDateCents,
          shortfallCents: progress.shortfallCents,
          missedDueOn: progress.missedDueOn,
          voidedEnvelopeId,
        },
      })

      if (ended === 'BROKEN') broken++
      else completed++
    }

    return { checked: plans.length, broken, completed }
  },
})
