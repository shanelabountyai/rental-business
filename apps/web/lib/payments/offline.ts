'use server'

import { createHash } from 'node:crypto'
import { balanceCents } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import {
  OFFLINE_INSTRUMENTS,
  OFFLINE_REFUSALS,
  offlinePaymentDecision,
  receiptBlocks,
  validateOfflinePayment,
} from '@rental/core/payments'
import type { OfflineChannel } from '@rental/core/payments'
import { businessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { recordAcrossInvoices } from '@/lib/payments/out-of-band.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Recording money somebody handed over (PAY-05, R-038).
//
// PAY-05 asks for this in UNDER FIFTEEN SECONDS, and that number is the
// design constraint rather than a nice-to-have: the alternative to a fast
// path is a shoebox of checks and a spreadsheet, which is the failure mode
// this whole product exists to replace. So the form asks for four things and
// derives everything else.
//
// THE ORDER HERE IS THE WHOLE DESIGN. Telling Stripe is what stops it
// collecting again; writing our own row is bookkeeping. If the push fails we
// must end up with nothing at all, because a Payment row we hold while Stripe
// goes on debiting the tenant is worse than no record - the staff member
// walks away believing it is handled.
//
// THE ROW IS NOW WRITTEN FIRST AND BACKED OUT ON FAILURE (D-177), which was
// Stripe-first until R-171 and produced a duplicate for every counter
// payment. The push makes the provider emit an `invoice.updated` carrying the
// same money, and `writePayment` writes a Payment row for it - against the
// simulator synchronously, inside the push call itself. Written afterwards,
// our row could never be the one that event found, so two rows landed for one
// payment (D-169) and everything that sums `Payment` doubled it. Written
// first, the event claims this row instead of minting a second, and the
// ordering holds for real Stripe too, where the webhook arrives later still.
//
// The end state on a failed push is unchanged - no Payment row, no ledger
// entry, an error the staff member can act on. What did change: the audit
// entry is written after the push rather than beside the row, because
// `AuditLog` is append-only and a `payment.recorded` entry cannot be taken
// back when the payment it names is.

export interface OfflineFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
  /// R-166: the counter receipt, once recorded. Absent on every refusal — a
  /// receipt for a payment that was refused would be evidence of money that
  /// never actually changed hands. Present beside the error when only part of
  /// a cheque landed (R-224): it receipts the part that did, and no more.
  receiptDocumentId?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function recordOfflinePayment(
  leasePayerId: string,
  _previous: OfflineFormState,
  formData: FormData,
): Promise<OfflineFormState> {
  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: leasePayerId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      stripeSubscriptionId: true,
      // PAY-12's part-payment switch. Read here rather than left to the
      // online path, because R-038a made a part-payment possible at the
      // counter for the first time.
      blockPartialPayments: true,
      // PAY-12's certified-funds switch, unread here since R-038a — the gap
      // R-155 closes. Without it a tenancy under legal action could pay by
      // personal check or cash at exactly the moment the switch says not to.
      certifiedFundsOnly: true,
      // Needed by the attach below: Stripe refuses to attach a payment
      // record whose customer is not the invoice's customer.
      stripeCustomerId: true,
      tenant: { select: { firstName: true, lastName: true } },
      externalPayerName: true,
      property: {
        select: {
          id: true,
          legalEntityId: true,
          timezone: true,
          name: true,
          legalEntity: { select: { name: true } },
        },
      },
      lease: { select: { unit: { select: { name: true } } } },
    },
  })

  // `ledger.adjust`, not `lease.write`. Recording money that arrived off the
  // rails is the most forgeable thing in the product - there is no processor
  // on the other side to disagree - so it sits behind the same privileged
  // permission as a ledger adjustment, and R-004 already treats that as
  // privileged for audit purposes.
  const actor = await requirePermission('ledger.adjust', propertyResource(payer.property))

  const dollars = str(formData, 'amountDollars')
  const input = {
    channel: str(formData, 'channel'),
    amountCents: dollars ? Math.round(Number(dollars) * 100) : Number.NaN,
    receivedOn: str(formData, 'receivedOn'),
    checkNumber: str(formData, 'checkNumber') || null,
    receivedByStaffId: actor.id,
  }

  const today = businessDate(new Date(), payer.property.timezone)
  const violations = validateOfflinePayment(input, today)
  if (violations.length > 0) {
    return {
      error: 'Check the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  // The customer, not the subscription: the invoices are listed by customer
  // (R-224), and the attach needs it anyway - Stripe refuses a payment record
  // whose customer is not the invoice's.
  const stripeCustomerId = payer.stripeCustomerId
  if (!payer.stripeSubscriptionId || !stripeCustomerId) {
    return { error: 'Billing is not set up for this payer yet, so there is nothing to apply this to.' }
  }

  const provider = getBillingProvider()
  const [entries, invoices] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: payer.leaseId },
      select: { id: true, amountCents: true },
    }),
    provider.getOpenInvoices({ stripeCustomerId }).catch((error) => {
      console.error(`[payments] could not read the open invoices for ${payer.id}`, error)
      return null
    }),
  ])

  const decision = offlinePaymentDecision(
    {
      balanceCents: balanceCents(
        entries.map((row) => ({ ...row, type: '', occurredAt: new Date(0), description: '' })),
      ),
      openInvoiceAmountCents:
        invoices?.reduce((total, invoice) => total + invoice.amountRemainingCents, 0) ?? null,
      blockPartial: payer.blockPartialPayments,
      certifiedFundsOnly: payer.certifiedFundsOnly,
      // Safe cast: `validateOfflinePayment` above refused anything that is
      // not an OfflineChannel before we got here.
      channel: input.channel as OfflineChannel,
    },
    input.amountCents,
  )
  if (!decision.allowed) {
    return { error: OFFLINE_REFUSALS[decision.refusal!] }
  }

  // What Stripe is told this was. Not free text a staff member types - it is
  // assembled here so the reference on Stripe's side always identifies the
  // instrument and the person, which is what a later reconciliation needs.
  const reference =
    input.channel === 'OFFLINE_CHECK'
      ? `check ${input.checkNumber} received by ${actor.id}`
      : `${input.channel.toLowerCase()} received by ${actor.id}`
  const instrument =
    input.channel === 'OFFLINE_CHECK' ? `Check ${input.checkNumber}` : OFFLINE_INSTRUMENTS[input.channel as OfflineChannel]

  const receivedAt = new Date(`${input.receivedOn}T12:00:00Z`)

  // OURS, because Stripe cannot hold it: which numbered instrument arrived
  // and who took it. The LEDGER entry is not written here - it arrives
  // through the webhook like every other payment, so there stays exactly
  // one way money enters the projection (D-11).
  //
  // Written BEFORE the push, with one split per invoice it covers - see
  // `recordAcrossInvoices` and this file's header. `receivedByStaffId` is
  // what the webhook recognises this row by.
  const outcome = await recordAcrossInvoices({
    provider,
    // Non-null: the decision above refused a null list as `no_open_invoice`.
    invoices: invoices!,
    payment: {
      propertyId: payer.propertyId,
      leaseId: payer.leaseId,
      leasePayerId: payer.id,
      channel: input.channel as OfflineChannel,
      // SETTLED, not PENDING. A check in hand is money received; whether it
      // clears is a separate future event (a returned check is a reversal,
      // which R-039's NSF handling owns), and holding it pending would keep
      // the tenant's balance wrong for days after they paid.
      status: 'SETTLED',
      amountCents: input.amountCents,
      receivedAt,
      receivedByStaffId: actor.id,
      checkNumber: input.checkNumber,
    },
    stripeCustomerId,
    reference,
    instrument,
    // KEYED ON THE FACT, not on the attempt: this payer, this instrument,
    // this amount, this day. A part-payment has no "already paid" state to
    // save it - R-038's whole-invoice call was protected by Stripe simply
    // refusing to pay a paid invoice, and attaching half of one twice is
    // money the tenant never handed over. A double submission now reports
    // the SAME payment record, which Stripe then refuses to attach twice.
    idempotencyKey: `offline:${payer.id}:${input.receivedOn}:${input.channel}:${input.checkNumber ?? ''}:${input.amountCents}`,
    logTag: 'payments',
  })

  if (outcome.recorded === 'none') {
    return {
      error:
        'That could not be recorded against the billing provider, so nothing has been saved. Try again shortly — do not record it twice.',
    }
  }
  const payment = { id: outcome.paymentId }
  const recordedCents = outcome.recorded === 'part' ? outcome.recordedCents : input.amountCents

  // AFTER the push, not beside the row. `AuditLog` is append-only, so an
  // entry saying a payment was recorded cannot be withdrawn when the row it
  // names is deleted above.
  await audit({
    action: 'payment.recorded',
    entityType: 'Payment',
    entityId: payment.id,
    propertyId: payer.propertyId,
    after: {
      channel: input.channel,
      amountCents: recordedCents,
      receivedOn: input.receivedOn,
      checkNumber: input.checkNumber,
      receivedByStaffId: actor.id,
      provider: provider.name,
    },
  })

  // The receipt is generated OUTSIDE the transaction above and its failure
  // does not undo the payment - rendering a PDF is real work (pdf-lib) that
  // does not belong inside an open database transaction, and a receipt that
  // failed to print is a much smaller problem than a recorded payment that
  // silently vanished because a PDF library threw. `notice`, not `error`:
  // the money is recorded either way.
  let receiptDocumentId: string | undefined
  try {
    const staff = await prisma.staffUser.findUnique({
      where: { id: actor.id },
      select: { name: true },
    })
    const payerName =
      payer.tenant != null
        ? `${payer.tenant.firstName} ${payer.tenant.lastName}`
        : (payer.externalPayerName ?? 'Payer')
    const bytes = await renderBlocksPdf(
      receiptBlocks({
        entityName: payer.property.legalEntity.name,
        propertyName: payer.property.name,
        unitName: payer.lease.unit.name,
        payerName,
        amountCents: recordedCents,
        channel: input.channel,
        checkNumber: input.checkNumber,
        receivedOn: friendlyDate(receivedAt, payer.property.timezone),
        receivedByName: staff?.name ?? 'Not recorded',
        generatedAt: friendlyTimestamp(new Date(), payer.property.timezone),
      }),
      { title: `Payment receipt — ${payer.property.name}` },
    )
    const buffer = Buffer.from(bytes)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const fileName = `receipt-${payment.id}.pdf`
    const storageKey = generateStorageKey(payer.propertyId, fileName)
    await storage.put(storageKey, buffer, 'application/pdf')

    receiptDocumentId = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          propertyId: payer.propertyId,
          leaseId: payer.leaseId,
          type: 'RECEIPT',
          fileName,
          contentType: 'application/pdf',
          sizeBytes: buffer.byteLength,
          storageKey,
          sha256,
          uploadedByStaffId: actor.id,
        },
      })
      await tx.payment.update({
        where: { id: payment.id },
        data: { receiptDocumentId: document.id },
      })
      await audit(
        {
          action: 'payment.receipt_generated',
          entityType: 'Payment',
          entityId: payment.id,
          propertyId: payer.propertyId,
          after: { documentId: document.id, sha256 },
        },
        tx,
      )
      return document.id
    })
  } catch (error) {
    console.error(`[payments] receipt generation failed for payment ${payment.id}`, error)
  }

  revalidatePath(`/leases/${payer.leaseId}`)
  revalidatePath('/money')
  if (outcome.recorded === 'part') {
    // Some invoices took their share and one refused. What landed is real
    // money at the provider and stays recorded; the rest is not, and saying
    // "recorded" would send the tenant home owing it (R-224).
    return {
      error: `Only ${formatCents(recordedCents)} of ${formatCents(input.amountCents)} could be recorded against the billing provider. Record the remaining ${formatCents(input.amountCents - recordedCents)} again shortly, on the same form.`,
      receiptDocumentId,
    }
  }
  return {
    notice: 'Recorded. The tenant will get a receipt once it posts.',
    receiptDocumentId,
  }
}
