'use server'

import { monthlyInstalments, validatePlanTerms } from '@rental/core/payments'
import { balanceCents } from '@rental/core/ledger'
import { businessDate, businessDateToUtc, friendlyBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Agreeing and cancelling a repayment plan (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// THIS IS THE ONLY WAY A `PAYMENT_PLAN` HOLD GETS PLACED, AND THAT IS THE
// WHOLE POINT OF THE ITEM.
//
// `placeLeaseHold` no longer offers the type. Before R-175 a repayment
// agreement WAS the hold - a sentence somebody typed, with nothing behind it
// that could say what was agreed or notice that it had stopped being kept.
// The hold is now a consequence of the plan: it is created here, in the same
// transaction, and lifted by the sweep or by a cancellation.
//
// `hold.manage`, not `lease.write`. This switches off the chase and the
// late-fee meter for a tenancy, which is exactly the authority the hold
// permission exists for; a plan is simply the reason.
// ==========================================================================

export interface PlanFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

export async function agreePaymentPlan(
  _previous: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const leaseId = String(formData.get('leaseId') ?? '')
  const dollars = String(formData.get('totalDollars') ?? '').trim()
  const count = Number(String(formData.get('instalments') ?? ''))
  const firstDueOn = String(formData.get('firstDueOn') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()

  if (!leaseId) return { error: 'No tenancy named.' }
  if (!note) {
    return {
      error: 'Say what was agreed.',
      fieldErrors: {
        note: 'What the tenant actually said they could do. The schedule below records the dates; this records why they are those dates.',
      },
    }
  }

  const totalCents = dollars ? Math.round(Number(dollars) * 100) : Number.NaN
  const terms = { totalCents, count, firstDueOn }
  const violations = validatePlanTerms(terms)
  if (violations.length > 0) {
    return {
      error: 'That schedule cannot be written.',
      fieldErrors: Object.fromEntries(
        violations.map((violation) => [
          violation.field === 'totalCents'
            ? 'totalDollars'
            : violation.field === 'count'
              ? 'instalments'
              : violation.field,
          violation.message,
        ]),
      ),
    }
  }

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy no longer exists.' }

  const actor = await requirePermission('hold.manage', propertyResource(lease.property))

  // AT MOST ONE ACTIVE PLAN PER TENANCY. Checked here rather than caught as
  // a constraint violation, the same call `placeLeaseHold` makes: the answer
  // somebody needs is "there is already one, agreed by Dana in March", not a
  // 500. The partial unique index that would express it cannot live in this
  // schema - see the migration.
  const existing = await prisma.paymentPlan.findFirst({
    where: { leaseId, status: 'ACTIVE' },
    select: { createdBy: { select: { name: true } } },
  })
  if (existing) {
    return {
      error: `A plan is already in force on this tenancy, agreed by ${existing.createdBy.name}. Cancel it before agreeing another.`,
    }
  }

  // A payment_plan hold placed the old way, by hand, before this existed.
  // It has no schedule and cannot be adopted by one, so it is in the way and
  // has to be lifted deliberately rather than silently replaced.
  const strayHold = await prisma.leaseHold.findFirst({
    where: { leaseId, type: 'PAYMENT_PLAN', liftedAt: null },
    select: { id: true },
  })
  if (strayHold) {
    return {
      error:
        'This tenancy already carries a payment-plan hold with no schedule behind it. Lift it in Holds first, then agree the plan here.',
    }
  }

  const entries = await prisma.ledgerEntry.findMany({
    where: { leaseId },
    select: {
      id: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      description: true,
      reversesId: true,
    },
  })

  const startedOn = businessDate(new Date(), lease.property.timezone)
  const instalments = monthlyInstalments(terms)

  const plan = await prisma.$transaction(async (tx) => {
    const created = await tx.paymentPlan.create({
      data: {
        leaseId,
        propertyId: lease.propertyId,
        arrearsCents: totalCents,
        // The PROPERTY's today, not the server's (D-3). A plan agreed at
        // 7pm in Texas from a machine in Europe must not start tomorrow.
        startedOn: businessDateToUtc(startedOn),
        note,
        createdByStaffId: actor.id,
        instalments: {
          create: instalments.map((instalment, index) => ({
            sequence: index + 1,
            dueOn: businessDateToUtc(instalment.dueOn),
            amountCents: instalment.amountCents,
          })),
        },
      },
      select: { id: true },
    })

    await tx.leaseHold.create({
      data: {
        leaseId,
        propertyId: lease.propertyId,
        type: 'PAYMENT_PLAN',
        reason: note,
        placedByStaffId: actor.id,
        paymentPlanId: created.id,
      },
    })

    return created
  })

  await audit({
    action: 'lease.payment_plan_agreed',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    reason: note,
    after: {
      planId: plan.id,
      arrearsCents: totalCents,
      startedOn,
      // THE SCHEDULE ITSELF, snapshotted. The instalment rows are immutable,
      // but a plan that was cancelled and re-agreed leaves two schedules on
      // the tenancy, and "what were they told they could pay" has to be
      // answerable without working out which row set was live in March.
      instalments,
      // The balance the plan was agreed against, which is NOT the same as
      // what it repays: an operator can agree a plan over part of a debt.
      balanceAtAgreementCents: balanceCents(entries),
    },
  })

  revalidatePath(`/leases/${leaseId}`)
  return {
    notice: `Plan agreed: ${instalments.length} ${instalments.length === 1 ? 'instalment' : 'instalments'} from ${friendlyBusinessDate(instalments[0].dueOn)}. The chase and the late-fee meter are off while it holds.`,
  }
}

export async function cancelPaymentPlan(
  _previous: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const planId = String(formData.get('planId') ?? '')
  const reason = String(formData.get('cancelReason') ?? '').trim()

  if (!planId) return { error: 'No plan named.' }
  if (!reason) {
    return {
      error:
        'A reason is required to cancel a plan. Collection and late fees resume against somebody who was told they had an arrangement.',
    }
  }

  const plan = await prisma.paymentPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      status: true,
      lease: { select: { property: { select: { id: true, legalEntityId: true } } } },
      hold: { select: { id: true, liftedAt: true } },
    },
  })
  if (!plan) return { error: 'That plan no longer exists.' }
  if (plan.status !== 'ACTIVE') return { error: 'That plan has already ended.' }

  const actor = await requirePermission('hold.manage', propertyResource(plan.lease.property))

  await prisma.$transaction(async (tx) => {
    await tx.paymentPlan.update({
      where: { id: planId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByStaffId: actor.id, cancelReason: reason },
    })
    // The hold goes with the plan. Leaving it on would be the exact failure
    // this item exists to fix, wearing the opposite sign: a chase switched
    // off for an agreement that no longer exists.
    if (plan.hold && plan.hold.liftedAt === null) {
      await tx.leaseHold.update({
        where: { id: plan.hold.id },
        data: { liftedAt: new Date(), liftedByStaffId: actor.id, liftReason: `Payment plan cancelled — ${reason}` },
      })
    }
  })

  await audit({
    action: 'lease.payment_plan_cancelled',
    entityType: 'Lease',
    entityId: plan.leaseId,
    propertyId: plan.propertyId,
    reason,
    after: { planId: plan.id, holdLifted: plan.hold != null && plan.hold.liftedAt === null },
  })

  revalidatePath(`/leases/${plan.leaseId}`)
  return { notice: 'Plan cancelled. The chase and the late-fee meter resume from now.' }
}
