'use server'

import { balanceCents } from '@rental/core/ledger'
import {
  OFFLINE_INSTRUMENTS,
  OFFLINE_REFUSALS,
  offlinePaymentDecision,
  validateOfflinePayment,
} from '@rental/core/payments'
import type { OfflineChannel } from '@rental/core/payments'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'

// Recording money somebody handed over (PAY-05, R-038).
//
// PAY-05 asks for this in UNDER FIFTEEN SECONDS, and that number is the
// design constraint rather than a nice-to-have: the alternative to a fast
// path is a shoebox of checks and a spreadsheet, which is the failure mode
// this whole product exists to replace. So the form asks for four things and
// derives everything else.
//
// THE ORDER HERE IS THE WHOLE DESIGN, and it is deliberately Stripe-first.
// Telling Stripe is what stops it collecting again; writing our own row is
// bookkeeping. If the push fails we write nothing at all, because a Payment
// row we hold while Stripe goes on debiting the tenant is worse than no
// record - the staff member walks away believing it is handled.

export interface OfflineFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
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
      // Needed by the attach below: Stripe refuses to attach a payment
      // record whose customer is not the invoice's customer.
      stripeCustomerId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
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

  if (!payer.stripeSubscriptionId) {
    return { error: 'Billing is not set up for this payer yet, so there is nothing to apply this to.' }
  }

  const provider = getBillingProvider()
  const [entries, invoice] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: payer.leaseId },
      select: { id: true, amountCents: true },
    }),
    provider
      .getOpenInvoice({ stripeSubscriptionId: payer.stripeSubscriptionId })
      .catch((error) => {
        console.error(`[payments] could not read the open invoice for ${payer.id}`, error)
        return null
      }),
  ])

  const decision = offlinePaymentDecision(
    {
      balanceCents: balanceCents(
        entries.map((row) => ({ ...row, type: '', occurredAt: new Date(0), description: '' })),
      ),
      openInvoiceAmountCents: invoice?.amountRemainingCents ?? null,
      blockPartial: payer.blockPartialPayments,
    },
    input.amountCents,
  )
  if (!decision.allowed) {
    return { error: OFFLINE_REFUSALS[decision.refusal!] }
  }

  if (!payer.stripeCustomerId) {
    return { error: 'Billing is not set up for this payer yet, so there is nothing to apply this to.' }
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

  try {
    await provider.recordOutOfBandPayment({
      stripeInvoiceId: invoice!.stripeInvoiceId,
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: input.amountCents,
      receivedAt,
      reference,
      instrument,
      // KEYED ON THE FACT, not on the attempt: this payer, this instrument,
      // this amount, this day. A part-payment has no "already paid" state to
      // save it - R-038's whole-invoice call was protected by Stripe simply
      // refusing to pay a paid invoice, and attaching half of one twice is
      // money the tenant never handed over. A double submission now reports
      // the SAME payment record, which Stripe then refuses to attach twice.
      idempotencyKey: `offline:${payer.id}:${input.receivedOn}:${input.channel}:${input.checkNumber ?? ''}:${input.amountCents}`,
    })
  } catch (error) {
    console.error(`[payments] out-of-band push failed for ${payer.id}`, error)
    return {
      error:
        'That could not be recorded against the billing provider, so nothing has been saved. Try again shortly — do not record it twice.',
    }
  }

  await prisma.$transaction(async (tx) => {
    // OURS, because Stripe cannot hold it: which numbered instrument arrived
    // and who took it. The LEDGER entry is not written here - it arrives
    // through the webhook like every other payment, so there stays exactly
    // one way money enters the projection (D-11).
    const payment = await tx.payment.create({
      data: {
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
        stripeInvoiceId: invoice!.stripeInvoiceId,
      },
    })

    await audit(
      {
        action: 'payment.recorded',
        entityType: 'Payment',
        entityId: payment.id,
        propertyId: payer.propertyId,
        after: {
          channel: input.channel,
          amountCents: input.amountCents,
          receivedOn: input.receivedOn,
          checkNumber: input.checkNumber,
          receivedByStaffId: actor.id,
          stripeInvoiceId: invoice!.stripeInvoiceId,
          provider: provider.name,
        },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${payer.leaseId}`)
  revalidatePath('/money')
  return { notice: 'Recorded. The tenant will get a receipt once it posts.' }
}
