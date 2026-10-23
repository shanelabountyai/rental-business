'use server'

import { createHash } from 'node:crypto'
import {
  balanceCents,
  computeDisposition,
  DEPOSIT_REFUND_INSTRUMENTS,
  type DepositRefundInstrument,
  dispositionLetterText,
  validateDepositRefund,
} from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import {
  businessDate,
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma, type PaymentChannel } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { recordAcrossInvoices } from '@/lib/payments/out-of-band.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { completeTaskWork } from '@/lib/tasks/complete.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Writes for deposit disposition (INSP-03, R-071).
//
// `ledger.adjust`, not `lease.write` - a deduction against money held on
// trust is exactly as forgeable as an offline payment, and
// `recordOfflinePayment`'s own comment already makes this call for the
// identical reason: there is no processor on the other side to disagree.
//
// EDITABLE UNTIL FINALIZED. `Deposit.dispositionSentAt` is the lock -
// checked here, in the action layer, the same posture `canEditItem` takes
// against `Inspection.lockedAt` rather than a database trigger, because
// this is a draft staff builds up before committing to a letter.

export interface DepositFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalInt(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Math.round(Number(raw)) : null
}

async function depositForWrite(depositId: string) {
  const deposit = await prisma.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      propertyId: true,
      leaseId: true,
      dispositionSentAt: true,
      property: { select: { id: true, legalEntityId: true, orgId: true } },
    },
  })
  const actor = await requirePermission('ledger.adjust', propertyResource(deposit.property))
  return { deposit, actor }
}

export async function addDeduction(
  depositId: string,
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const { deposit, actor } = await depositForWrite(depositId)
  if (deposit.dispositionSentAt) {
    return { error: 'This disposition has already been finalized.' }
  }

  const description = str(formData, 'description')
  const dollars = str(formData, 'amountDollars')
  const amountCents = dollars ? Math.round(Number(dollars) * 100) : Number.NaN
  const workOrderId = str(formData, 'workOrderId') || null
  const inspectionItemId = str(formData, 'inspectionItemId') || null
  const estimatedAgeYears = optionalInt(formData, 'estimatedAgeYears')
  const usefulLifeYears = optionalInt(formData, 'usefulLifeYears')

  const fieldErrors: Record<string, string> = {}
  if (!description) fieldErrors.description = 'Describe the deduction.'
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    fieldErrors.amountDollars = 'Enter how much to deduct.'
  }
  // SEC-12: both ids come off the form, and the packet embeds whatever they
  // point at. Another property's work order or inspection item is not-found.
  const [workOrder, inspectionItem] = await Promise.all([
    workOrderId
      ? prisma.workOrder.findFirst({
          where: { id: workOrderId, propertyId: deposit.propertyId },
          select: { id: true },
        })
      : null,
    inspectionItemId
      ? prisma.inspectionItem.findFirst({
          where: { id: inspectionItemId, inspection: { propertyId: deposit.propertyId } },
          select: { id: true },
        })
      : null,
  ])
  if (workOrderId && !workOrder) fieldErrors.workOrderId = 'That work order was not found.'
  if (inspectionItemId && !inspectionItem) {
    fieldErrors.inspectionItemId = 'That inspection item was not found.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  await prisma.$transaction(async (tx) => {
    const deduction = await tx.depositDeduction.create({
      data: {
        propertyId: deposit.propertyId,
        depositId: deposit.id,
        description,
        amountCents,
        workOrderId,
        inspectionItemId,
        estimatedAgeYears,
        usefulLifeYears,
        createdByStaffId: actor.id,
      },
    })

    const file = formData.get('file')
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const contentType = file.type || 'application/octet-stream'
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const storageKey = generateStorageKey(deposit.propertyId, file.name)
      await storage.put(storageKey, buffer, contentType)
      await tx.document.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          depositDeductionId: deduction.id,
          type: 'INVOICE',
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          storageKey,
          sha256,
          uploadedByStaffId: actor.id,
        },
      })
    }

    await audit(
      {
        action: 'deposit.deduction_added',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: deposit.propertyId,
        after: { description, amountCents, workOrderId, inspectionItemId },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${deposit.leaseId}/deposit`)
  return { notice: 'Deduction added.' }
}

export async function removeDeduction(deductionId: string): Promise<DepositFormState> {
  const deduction = await prisma.depositDeduction.findUniqueOrThrow({
    where: { id: deductionId },
    select: {
      id: true,
      description: true,
      amountCents: true,
      deposit: {
        select: {
          id: true,
          leaseId: true,
          propertyId: true,
          dispositionSentAt: true,
          property: { select: { id: true, legalEntityId: true, orgId: true } },
        },
      },
    },
  })
  await requirePermission('ledger.adjust', propertyResource(deduction.deposit.property))
  if (deduction.deposit.dispositionSentAt) {
    return { error: 'This disposition has already been finalized.' }
  }

  await prisma.$transaction(async (tx) => {
    // Evidence documents are not deleted - they lose their
    // `depositDeductionId` link (the FK's own `ON DELETE SET NULL`) and
    // stay on file under the lease, the same "retire the pointer, keep the
    // record" posture DOC-05 already takes.
    await tx.depositDeduction.delete({ where: { id: deductionId } })
    await audit(
      {
        action: 'deposit.deduction_removed',
        entityType: 'Deposit',
        entityId: deduction.deposit.id,
        propertyId: deduction.deposit.propertyId,
        after: { description: deduction.description, amountCents: deduction.amountCents },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${deduction.deposit.leaseId}/deposit`)
  return { notice: 'Removed.' }
}

/**
 * Locks the deduction list, computes the final totals, and creates the
 * disposition letter as a real `Notice` (DEPOSIT_DISPOSITION) - from here,
 * generating the PDF and recording its service to the forwarding address is
 * R-051's existing `/notices/[id]` page, unmodified.
 */
export async function finalizeDisposition(
  depositId: string,
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const deposit = await prisma.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      propertyId: true,
      leaseId: true,
      heldCents: true,
      dispositionDueOn: true,
      dispositionSentAt: true,
      forwardingAddress: true,
      property: { select: { id: true, legalEntityId: true, orgId: true, addressLine1: true, timezone: true } },
      lease: {
        select: {
          id: true,
          moveOutAt: true,
          unit: { select: { name: true } },
          leaseTenants: {
            where: { isPrimary: true },
            take: 1,
            select: { tenant: { select: { firstName: true, lastName: true } } },
          },
          // R-209: who the applied deposit is paid ON BEHALF OF. Same shape
          // as `waiveCharge`'s own lookup - one active payer, because that
          // is the payer whose Stripe customer holds the arrears being
          // settled.
          leasePayers: {
            where: { active: true },
            take: 1,
            select: {
              id: true,
              stripeCustomerId: true,
              stripeSubscriptionId: true,
            },
          },
        },
      },
      deductions: { select: { id: true, description: true, amountCents: true } },
    },
  })
  const actor = await requirePermission('ledger.adjust', propertyResource(deposit.property))
  if (deposit.dispositionSentAt) return { error: 'This disposition has already been finalized.' }
  if (!deposit.lease.moveOutAt) {
    return { error: 'No move-out date is on record for this tenancy yet.' }
  }
  // The form's own checkbox is `required`, so this only fires for a submit
  // that did not come from it. It stays because the browser check is a
  // convenience and this is the gate (R-116).
  if (!formData.get('acknowledgeFinal')) {
    return { error: 'Confirm you understand the letter cannot be undone.' }
  }

  const forwardingAddress = str(formData, 'forwardingAddress') || deposit.forwardingAddress
  if (!forwardingAddress) {
    return {
      error: 'A forwarding address is required to send the disposition letter.',
      fieldErrors: { forwardingAddress: 'Required.' },
    }
  }

  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: { leaseId: deposit.leaseId },
    select: { id: true, type: true, amountCents: true, occurredAt: true, description: true },
  })
  const deductedCents = deposit.deductions.reduce((sum, d) => sum + d.amountCents, 0)
  const totals = computeDisposition(deposit.heldCents, deductedCents, balanceCents(ledgerRows))

  const primaryTenant = deposit.lease.leaseTenants[0]?.tenant
  const tenantName = primaryTenant ? `${primaryTenant.firstName} ${primaryTenant.lastName}` : 'Tenant'
  const bodyText = dispositionLetterText({
    tenantName,
    addressLine1: deposit.property.addressLine1,
    unitName: deposit.lease.unit.name,
    timezone: deposit.property.timezone,
    moveOutOn: deposit.lease.moveOutAt,
    deductions: deposit.deductions,
    totals,
  })

  // ==========================================================================
  // THE APPLIED DEPOSIT HAS TO REACH THE LEDGER (R-209).
  //
  // This used to write `appliedCents` onto the Deposit row, into the letter,
  // and nowhere else. A tenant moving out owing $1,500 with $1,500 held got
  // a letter correctly saying the deposit had settled it - and
  // `balanceCents()` went on reporting $1,500 for ever, so the lease page,
  // `statementForPeriod`, R-083's attorney packet and anything handed to a
  // collections agency all disagreed with the letter the tenant was holding.
  // Demanding money already taken out of the deposit is how a clean move-out
  // becomes a counterclaim.
  //
  // IT IS A PAYMENT, NOT A LEDGER WRITE. `LedgerEntry` is an append-only
  // projection and the webhook is its ONLY production writer (D-11) - a row
  // inserted here is a row Stripe does not know about, which the schema's own
  // comment calls a reconciliation bug rather than a shortcut. And a payment
  // is what this actually is: the money genuinely arrived, at move-in, and
  // has been sitting as a liability ever since; the disposition is the act
  // that converts part of it into satisfaction of a receivable. So it goes
  // out the same way a check handed over at the counter does - our Payment
  // row first, then `recordOutOfBandPayment`, then the projection arrives on
  // the event (`recordOfflinePayment` in lib/payments/offline.ts is the
  // worked example, and D-177 is why the row is written BEFORE the push).
  //
  // A customer-balance credit would have been the shorter call and cannot
  // work: `interpretStripeEvent` reads `amount_due`, which a balance credit
  // is deliberately outside of, so it would never project at all. A negative
  // invoice item - `waiveCharge`'s shape - cannot work either, because it
  // only lands on a FUTURE invoice and this tenancy's subscription is over.
  //
  // BEFORE the letter, so a push that fails leaves nothing at all: no
  // disposition, no Task, nothing to reconcile, and an error staff can act
  // on. Same posture as `waiveCharge` and `recordOfflinePayment`.
  const payer = deposit.lease.leasePayers[0]
  if (totals.ledgerAppliedCents > 0) {
    if (!payer?.stripeCustomerId || !payer.stripeSubscriptionId) {
      return {
        error:
          'Billing is not set up for this tenancy, so the outstanding balance cannot be settled from the deposit. Sort the billing link out first — finalizing now would send a letter the ledger disagrees with.',
      }
    }

    const provider = getBillingProvider()
    const invoices = await provider
      .getOpenInvoices({ stripeCustomerId: payer.stripeCustomerId })
      .catch((error) => {
        console.error(`[deposits] could not read the open invoices for ${payer.id}`, error)
        return null
      })

    // SPREAD OVER EVERY OPEN INVOICE, oldest first (R-224). This used to
    // attach to the first open invoice only and refuse whenever the arrears
    // spanned more than one, which on real Stripe is every tenancy more than
    // a month behind. What still refuses is the provider not holding the
    // arrears at all - the letter and the ledger would then disagree.
    const openCents = invoices?.reduce((total, i) => total + i.amountRemainingCents, 0) ?? 0
    if (!invoices || openCents < totals.ledgerAppliedCents) {
      return {
        error: `The billing provider shows less than the ${formatCents(totals.ledgerAppliedCents)} outstanding balance on its open invoices, so it cannot be settled from the deposit. Reconcile the ledger first, then finalize.`,
      }
    }

    // The row and its splits are WRITTEN FIRST, so the events the pushes fire
    // claim them instead of minting a second row (D-177). `OTHER` is the
    // channel because the money did not arrive on a rail today - it arrived
    // at move-in.
    const outcome = await recordAcrossInvoices({
      provider,
      invoices,
      payment: {
        propertyId: deposit.propertyId,
        leaseId: deposit.leaseId,
        leasePayerId: payer.id,
        channel: 'OTHER',
        status: 'SETTLED',
        amountCents: totals.ledgerAppliedCents,
        receivedAt: new Date(),
        receivedByStaffId: actor.id,
      },
      stripeCustomerId: payer.stripeCustomerId,
      reference: `security deposit applied at disposition by ${actor.id}`,
      instrument: 'Security deposit',
      // KEYED ON THE DEPOSIT, which is disposed of exactly once. A retry
      // after the transaction below threw reports the SAME payment records
      // and Stripe refuses to attach them twice, so the money cannot move
      // twice; what it does leave is a second unclaimed Payment row, which
      // is debris rather than a wrong balance. That window - push landed,
      // local transaction failed - is the known ceiling here, and closing
      // it properly needs a column on Payment naming the deposit.
      idempotencyKey: `deposit-disposition:${deposit.id}`,
      logTag: 'deposits',
    })

    if (outcome.recorded === 'none') {
      return {
        error:
          'The deposit could not be applied to the outstanding balance at the billing provider, so nothing has been sent. Try again shortly.',
      }
    }
    if (outcome.recorded === 'part') {
      // ponytail: no resume for a disposition whose push stopped part-way; a
      // retry re-applies the whole amount and is refused on the smaller
      // balance. Rare (a provider failure between two invoices of one call);
      // resume from the recorded splits if it is ever seen.
      return {
        error: `Only ${formatCents(outcome.recordedCents)} of the ${formatCents(totals.ledgerAppliedCents)} could be applied at the billing provider before it stopped answering. Nothing has been sent to the tenant. The rest needs settling by hand before this can be finalized.`,
      }
    }
    const payment = { id: outcome.paymentId }

    // AFTER the push, never beside the row: `AuditLog` is append-only, so an
    // entry naming a payment cannot be withdrawn when that payment is.
    await audit({
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      propertyId: deposit.propertyId,
      after: {
        channel: 'OTHER',
        amountCents: totals.ledgerAppliedCents,
        depositId: deposit.id,
        receivedByStaffId: actor.id,
        provider: provider.name,
      },
      reason: 'Security deposit applied to the outstanding balance at disposition',
    })
  }

  let uncoveredCharge: { id: string; amountCents: number; description: string } | null = null
  const notice = await prisma.$transaction(async (tx) => {
    // D-307: this transaction now writes to the ledger, so it takes the
    // per-lease lock every other ledger writer plans under (MONEY-16, D-302)
    // and re-reads the one marker that says the letter is out. The check at
    // the top of this action is outside the transaction: two presses in one
    // instant both passed it and wrote two letters.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lease-allocation:${deposit.leaseId}`}))`
    const current = await tx.deposit.findUniqueOrThrow({
      where: { id: deposit.id },
      select: { dispositionSentAt: true },
    })
    if (current.dispositionSentAt) return null

    const created = await tx.notice.create({
      data: {
        propertyId: deposit.propertyId,
        leaseId: deposit.leaseId,
        type: 'DEPOSIT_DISPOSITION',
        addressOfRecord: forwardingAddress,
        bodyText,
      },
    })
    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        noticeId: created.id,
        dispositionSentAt: new Date(),
        forwardingAddress,
        appliedCents: totals.appliedCents,
        refundedCents: totals.refundedCents,
        creditAppliedCents: totals.creditAppliedCents,
        creditRefundedCents: totals.creditRefundedCents,
      },
    })
    await audit(
      {
        action: 'deposit.disposition_finalized',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: deposit.propertyId,
        after: { noticeId: created.id, ...totals },
      },
      tx,
    )
    // D-307: THE CREDIT SET AGAINST DEDUCTIONS BEYOND THE DEPOSIT LEAVES THE
    // LEDGER HERE, with the letter that says so. A ledger-only row like the
    // credit it spends (D-302) and the one that pays the rest of it out
    // (D-306): Stripe holds none of the three, and is invoiced below for the
    // difference only. Without it the ledger would go on showing a credit
    // the letter has just told the tenant was used up - and the next
    // disbursement or disposition to read that balance would pay it again.
    if (totals.creditAppliedCents > 0) {
      const entry = await tx.ledgerEntry.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          leasePayerId: payer?.id ?? null,
          type: 'ADJUSTMENT',
          amountCents: totals.creditAppliedCents,
          description: 'Credit balance applied to deductions beyond the security deposit',
          occurredAt: new Date(),
        },
        select: { id: true },
      })
      await audit(
        {
          action: 'ledger.adjusted',
          entityType: 'LedgerEntry',
          entityId: entry.id,
          propertyId: deposit.propertyId,
          reason: 'Credit balance applied to deductions beyond the security deposit',
          after: {
            type: 'ADJUSTMENT',
            creditApplied: true,
            ledgerOnly: true,
            amountCents: totals.creditAppliedCents,
            depositId: deposit.id,
          },
        },
        tx,
      )
    }

    // R-215: DAMAGE THE DEPOSIT COULD NOT COVER BECOMES A RECEIVABLE. Until
    // this it existed only as a sentence in the letter ("we will contact you
    // separately"), and left every list an operator reads the day the
    // tenancy ended. In the same transaction as the letter, so the two cannot
    // disagree; billed to Stripe AFTER it (below) so a provider outage cannot
    // strand a disposition whose R-209 payment already moved - a retry would
    // recompute from a ledger that payment has since changed.
    if (totals.uncoveredDeductionsCents > 0) {
      uncoveredCharge = await tx.charge.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          type: 'OTHER',
          amountCents: totals.uncoveredDeductionsCents,
          // D-307: the amount is net of any credit applied above, and the
          // tenant reads this line on the invoice.
          description:
            totals.creditAppliedCents > 0
              ? 'Damages and deductions beyond the security deposit, less the credit on your account'
              : 'Damages and deductions beyond the security deposit',
          // Property-local today, for the same reason chargebacks read it so.
          dueOn: businessDateToUtc(businessDate(new Date(), deposit.property.timezone)),
          depositId: deposit.id,
        },
        select: { id: true, amountCents: true, description: true },
      })
    }

    // R-170: the letter promises money back; SOMEBODY HAS TO CUT THE CHEQUE.
    // Raised here, in the same transaction as the letter, because a letter
    // without the obligation behind it is exactly the state this item
    // exists to remove - and it goes in the one queue (D-9), not a second
    // "refunds to pay" table.
    //
    // LAST in the transaction on purpose. `createTask` swallows a duplicate
    // by catching P2002, which leaves this transaction aborted at the
    // Postgres level - so nothing may follow it. It cannot actually fire
    // here (the `dispositionSentAt` guard above means a deposit is finalized
    // once), and if it somehow did, the whole finalization failing is the
    // safe direction: no letter, nothing to reconcile.
    //
    // D-303: raised for a returned CREDIT too, and titled with the whole
    // amount to pay. `Deposit.refundedCents` above stays deposit money only;
    // the credit is stored beside it as `creditRefundedCents`, and that is
    // what is left of it after D-307's netting.
    if (totals.totalRefundCents > 0) {
      // R-188: DATED WITH THE DEADLINE, NOT WITH TODAY. This was
      // `businessDate(new Date(), ...)` - the day the letter was finalized -
      // so the one URGENT row left watching the refund read *Overdue* from
      // the following morning and never once named the statutory date. A
      // queue whose urgent item is overdue on day two is a queue nobody
      // reads on day twenty. `dispositionDueOn` is a `@db.Date` and takes
      // `utcToBusinessDate`, never a zone (D-3); the fallback is only
      // reachable for a deposit whose clock was never started.
      const refundDueOn = deposit.dispositionDueOn
        ? utcToBusinessDate(deposit.dispositionDueOn)
        : businessDate(new Date(), deposit.property.timezone)
      await createTask(tx, {
        propertyId: deposit.propertyId,
        type: 'deposit_refund_due',
        subjectType: 'Deposit',
        subjectId: deposit.id,
        businessDate: refundDueOn,
        // A statutory deadline the owner has already passed the decision
        // point on. Late here is treble damages in Texas, not a late fee.
        priority: 'URGENT',
        // Three shapes, because "the $0.00 deposit refund plus..." is a
        // title nobody trusts: both, the credit alone (D-307 makes that the
        // ordinary case when deductions pass the deposit), the deposit alone.
        title:
          totals.creditRefundedCents === 0
            ? `Pay ${tenantName} the ${formatCents(totals.refundedCents)} deposit refund by ${friendlyBusinessDate(refundDueOn)}`
            : totals.refundedCents === 0
              ? `Pay ${tenantName} ${formatCents(totals.creditRefundedCents)} by ${friendlyBusinessDate(refundDueOn)}: the credit on their account, none of it deposit money`
              : `Pay ${tenantName} ${formatCents(totals.totalRefundCents)} by ${friendlyBusinessDate(refundDueOn)}: the ${formatCents(totals.refundedCents)} deposit refund plus the ${formatCents(totals.creditRefundedCents)} credit on their account`,
      })
    }
    return created
  })
  if (!notice) return { error: 'This disposition has already been finalized.' }

  // NOT FATAL, the same posture a chargeback takes: the Charge stands and the
  // letter is out, and an unbilled charge is shown as such on the former-
  // tenants screen rather than lost. No payer means nothing to bill yet.
  if (uncoveredCharge && payer?.stripeCustomerId) {
    const charge: { id: string; amountCents: number; description: string } = uncoveredCharge
    try {
      const { stripeInvoiceId } = await getBillingProvider().invoiceOneOffCharge({
        stripeCustomerId: payer.stripeCustomerId,
        amountCents: charge.amountCents,
        currency: 'usd',
        description: charge.description,
        chargeId: charge.id,
        idempotencyKey: `deposit-uncovered:${deposit.id}`,
      })
      await prisma.charge.update({ where: { id: charge.id }, data: { stripeInvoiceId } })
    } catch (error) {
      console.error(`[deposits] could not bill uncovered deductions charge ${charge.id}`, error)
    }
  }

  revalidatePath(`/leases/${deposit.leaseId}/deposit`)
  redirect(`/notices/${notice.id}`)
}

/**
 * The refund actually leaving (R-170).
 *
 * `finalizeDisposition` decides the number and puts it in writing; this is
 * the only thing that makes it paid. Until it runs, `depositLiabilityCents`
 * keeps the money on the books as owed, which is what the rent roll, the
 * handoff file and the year-end packet all read.
 *
 * `ledger.adjust`, the same privileged permission the rest of this file
 * sits behind: there is no processor on the other side to disagree that the
 * cheque was written, so a refund somebody types in is exactly as forgeable
 * as an offline payment.
 *
 * WRITE-ONCE, deliberately, and for the same reason a deduction cannot be
 * edited after finalization: this is the evidence the owner produces when a
 * tenant says the deposit was never returned. A correction is a matter for
 * the audit trail and a second, real disbursement - not an edit that leaves
 * no trace of what it replaced.
 */
export async function recordDepositRefund(
  depositId: string,
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const deposit = await prisma.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      propertyId: true,
      leaseId: true,
      refundedCents: true,
      creditRefundedCents: true,
      dispositionSentAt: true,
      refundPaidOn: true,
      property: { select: { id: true, legalEntityId: true, orgId: true, timezone: true } },
      // D-306: whose ledger the paid-out credit comes off. The same one
      // active payer `finalizeDisposition` reads.
      lease: { select: { leasePayers: { where: { active: true }, take: 1, select: { id: true } } } },
    },
  })
  const actor = await requirePermission('ledger.adjust', propertyResource(deposit.property))

  if (!deposit.dispositionSentAt) {
    return { error: 'Finalize the disposition before recording a refund against it.' }
  }
  if (deposit.refundPaidOn) {
    return { error: 'This refund has already been recorded.' }
  }
  // D-305: one disbursement covers the deposit refund and any ledger credit
  // the letter returned with it, so a disposition that returns only a credit
  // is still recorded here.
  const paidCents = deposit.refundedCents + deposit.creditRefundedCents
  if (paidCents <= 0) {
    return { error: 'This disposition refunds nothing, so there is nothing to pay.' }
  }

  const method = str(formData, 'method')
  const paidOn = str(formData, 'paidOn')
  const reference = str(formData, 'reference') || null
  const today = businessDate(new Date(), deposit.property.timezone)
  const violations = validateDepositRefund({ method, paidOn, reference }, today)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const recorded = await prisma.$transaction(async (tx) => {
    // D-306: the same per-lease lock the move-out credit is posted under
    // (D-302) and a settling payment plans under (MONEY-16). THE LOCK AND
    // THE RE-READ BELOW ARE THE IDEMPOTENCY: the check at the top of this
    // action is outside the transaction, so two presses in one instant both
    // pass it, and before this both wrote the refund and its audit row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lease-allocation:${deposit.leaseId}`}))`
    const current = await tx.deposit.findUniqueOrThrow({
      where: { id: deposit.id },
      select: { refundPaidOn: true },
    })
    if (current.refundPaidOn) return false

    let refundDocumentId: string | null = null
    const file = formData.get('file')
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const contentType = file.type || 'application/octet-stream'
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const storageKey = generateStorageKey(deposit.propertyId, file.name)
      await storage.put(storageKey, buffer, contentType)
      const document = await tx.document.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          type: 'RECEIPT',
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          storageKey,
          sha256,
          uploadedByStaffId: actor.id,
        },
      })
      refundDocumentId = document.id
    }

    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        // A calendar day straight through - `businessDateToUtc` is the only
        // reader a @db.Date column takes, and no zone may touch it (D-3).
        refundPaidOn: businessDateToUtc(paidOn),
        refundMethod: method as PaymentChannel,
        refundReference: reference,
        refundDocumentId,
        refundRecordedById: actor.id,
      },
    })

    await audit(
      {
        action: 'deposit.refund_recorded',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: deposit.propertyId,
        after: {
          amountCents: paidCents,
          depositRefundCents: deposit.refundedCents,
          creditRefundedCents: deposit.creditRefundedCents,
          method,
          reference,
          paidOn,
          refundDocumentId,
        },
      },
      tx,
    )

    // D-306: THE CREDIT LEAVES THE LEDGER WHEN THE MONEY LEAVES THE BANK.
    // Without this the tenant's account went on reading in credit for money
    // they had already been handed. A ledger-only row like the credit it
    // answers (D-302): Stripe was never told about either, so there is no
    // event to project it from, and `leaseBalanceAtStripeCents` leaves both
    // out of what it expects Stripe to agree with.
    //
    // THE STORED FIGURE, not today's balance: it is what was paid. A charge
    // that landed after the letter is still owed, and stays showing.
    //
    // In this transaction, so `refundPaidOn` above is the one marker for
    // both: a refund is recorded and its credit taken off, or neither.
    if (deposit.creditRefundedCents > 0) {
      const entry = await tx.ledgerEntry.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          leasePayerId: deposit.lease.leasePayers[0]?.id ?? null,
          // ADJUSTMENT, which nothing else writes: not a CHARGE (it is not
          // income, and the accrual export reads unlinked CHARGE rows as
          // rent) and not a REVERSAL (the credit was right; it was paid).
          type: 'ADJUSTMENT',
          amountCents: deposit.creditRefundedCents,
          description: `Credit balance returned with the deposit refund on ${friendlyBusinessDate(paidOn)}`,
          // When it was posted, not `paidOn`: an entry slipped into the past
          // would change running balances already printed on a statement.
          occurredAt: new Date(),
        },
        select: { id: true },
      })
      await audit(
        {
          action: 'ledger.adjusted',
          entityType: 'LedgerEntry',
          entityId: entry.id,
          propertyId: deposit.propertyId,
          reason: 'Credit balance paid out with the deposit refund',
          after: {
            type: 'ADJUSTMENT',
            creditPaidOut: true,
            ledgerOnly: true,
            amountCents: deposit.creditRefundedCents,
            depositId: deposit.id,
          },
        },
        tx,
      )
    }

    // Closes the obligation finalization raised. Not a second queue and not
    // a second notion of "done" - `completeTaskWork` is the one write that
    // marks a Task complete (D-9), and the disbursement IS the completion,
    // exactly as a triage decision is for a ticket task.
    const task = await tx.task.findFirst({
      where: {
        type: 'deposit_refund_due',
        subjectId: deposit.id,
        status: { notIn: ['DONE', 'CANCELED'] },
      },
      select: { id: true, type: true, status: true, propertyId: true },
    })
    if (task) {
      await completeTaskWork(tx, task, actor.id, {
        note: `${formatCents(paidCents)} by ${DEPOSIT_REFUND_INSTRUMENTS[method as DepositRefundInstrument].toLowerCase()} on ${friendlyBusinessDate(paidOn)}${reference ? ` (${reference})` : ''}`,
      })
    }
    return true
  })
  if (!recorded) return { error: 'This refund has already been recorded.' }

  revalidatePath(`/leases/${deposit.leaseId}/deposit`)
  revalidatePath('/tasks')
  return { notice: 'Refund recorded.' }
}
