import 'server-only'

import { splitAcrossInvoices } from '@rental/core/payments'
import type { OpenInvoice } from '@rental/core/payments'
import { prisma } from '@rental/db'
import type { Prisma } from '@rental/db'
import type { BillingProvider } from '@/lib/billing/adapter.ts'

// Money we recorded ourselves, pushed to Stripe across however many open
// invoices it covers (R-224). The counter (`recordOfflinePayment`) and a
// deposit applied to arrears (`finalizeDisposition`) both go out this way.
//
// ONE Payment row, one split per invoice. Stripe attaches money to one invoice
// at a time, so a cheque for two months is two pushes and comes back as two
// `invoice.updated` events; the webhook claims each against its split.
//
// THE ROW AND ITS SPLITS ARE WRITTEN FIRST (D-177): the event a push fires
// must find them, and against the simulator it fires inside the push call.
//
// A FAILED PUSH backs out only what did not land. Nothing landed: the row is
// deleted, as before. Some landed: those slices are real money at Stripe, and
// against the simulator their ledger entries already point at this row, so
// the row stays, shrunk to what landed, and the caller says so.

export type OutOfBandOutcome =
  | { recorded: 'all'; paymentId: string }
  | { recorded: 'part'; paymentId: string; recordedCents: number }
  | { recorded: 'none' }

export async function recordAcrossInvoices(input: {
  provider: BillingProvider
  invoices: readonly OpenInvoice[]
  /// Everything but the invoice fields, which are derived here.
  payment: Omit<Prisma.PaymentUncheckedCreateInput, 'stripeInvoiceId' | 'invoiceSplits'> & {
    amountCents: number
    receivedAt: Date
  }
  stripeCustomerId: string
  reference: string
  instrument: string
  /// Keyed on the fact. Each slice appends its invoice, so a retry of the
  /// same fact reports the same payment record per invoice.
  idempotencyKey: string
  logTag: string
}): Promise<OutOfBandOutcome> {
  const splits = splitAcrossInvoices(input.payment.amountCents, input.invoices)

  const payment = await prisma.payment.create({
    data: {
      ...input.payment,
      // The single invoice when there is one, so a row reads as it always
      // has. The splits are the record either way; the webhook reads those.
      stripeInvoiceId: splits.length === 1 ? splits[0]!.stripeInvoiceId : null,
      invoiceSplits: { create: splits },
    },
    select: { id: true },
  })

  const { landed, landedCents } = await pushSplits({ ...input, splits })

  if (landed.length === splits.length) return { recorded: 'all', paymentId: payment.id }

  if (landed.length === 0) {
    // Nothing can be pinning the row: the only thing that projects a ledger
    // entry against it is an event no push fired. A cleanup that fails anyway
    // is logged and swallowed - the push failure is the error staff need.
    await prisma.payment.delete({ where: { id: payment.id } }).catch((cleanupError) => {
      console.error(`[${input.logTag}] could not back out payment ${payment.id}`, cleanupError)
    })
    return { recorded: 'none' }
  }

  await prisma.$transaction([
    prisma.paymentInvoiceSplit.deleteMany({
      where: { paymentId: payment.id, stripeInvoiceId: { notIn: landed } },
    }),
    prisma.payment.update({
      where: { id: payment.id },
      data: {
        amountCents: landedCents,
        stripeInvoiceId: landed.length === 1 ? landed[0] : null,
      },
    }),
  ])
  return { recorded: 'part', paymentId: payment.id, recordedCents: landedCents }
}

/**
 * A settled PORTAL payment, applied to the payer's open invoices (MONEY-01).
 *
 * The money is already in the ledger - its own `payment_intent.succeeded`
 * projected it. What was missing is Stripe's side: a standalone PaymentIntent
 * touches no invoice, so the invoice stayed open and Stripe went on
 * collecting it. A declined autopay, a portal payment, then Stripe's own
 * retry succeeding was rent taken twice.
 *
 * SAME PUSH AS THE COUNTER, same order (D-177): splits first, on the
 * EXISTING row, then one payment record per invoice. Each push echoes back
 * as an `invoice.updated`, which `claimPortalEcho` absorbs against its split
 * without a second ledger entry. A payment record rather than attaching the
 * PaymentIntent itself, because Stripe refuses an intent larger than what the
 * invoice has left - which every card payment with a fee is - and one intent
 * cannot be spread over two invoices (both measured, D-268). The intent id is
 * the record's reference, so Stripe's side still names the money.
 *
 * Only the PRINCIPAL is applied. The card fee paid for the privilege of
 * paying by card and settles no invoice.
 */
export async function applyPortalPayment(input: {
  provider: BillingProvider
  paymentId: string
  stripeCustomerId: string
  stripePaymentIntentId: string
  principalCents: number
  receivedAt: Date
}): Promise<{ appliedCents: number }> {
  const invoices = await input.provider.getOpenInvoices({ stripeCustomerId: input.stripeCustomerId })
  if (!invoices) throw new Error(`could not list open invoices for ${input.stripeCustomerId}`)
  const open = invoices.reduce((total, invoice) => total + invoice.amountRemainingCents, 0)
  // ponytail: money beyond the open invoices (a prepayment) stays a ledger
  // credit Stripe cannot see, so next month's invoice is collected in full.
  const splits = splitAcrossInvoices(Math.min(input.principalCents, open), invoices)
  if (splits.length === 0) return { appliedCents: 0 }

  await prisma.paymentInvoiceSplit.createMany({
    data: splits.map((split) => ({ ...split, paymentId: input.paymentId })),
  })
  const { landed, landedCents } = await pushSplits({
    provider: input.provider,
    splits,
    stripeCustomerId: input.stripeCustomerId,
    payment: { receivedAt: input.receivedAt },
    reference: input.stripePaymentIntentId,
    instrument: 'Portal payment',
    idempotencyKey: `portal:${input.stripePaymentIntentId}`,
    logTag: 'portal-payment',
  })
  if (landed.length < splits.length) {
    await prisma.paymentInvoiceSplit.deleteMany({
      where: { paymentId: input.paymentId, stripeInvoiceId: { notIn: landed } },
    })
  }
  return { appliedCents: landedCents }
}

/// One push per split, oldest first, stopping at the first refusal: what
/// landed is real money at Stripe, what did not is the caller's to back out.
async function pushSplits(input: {
  provider: BillingProvider
  splits: readonly { stripeInvoiceId: string; amountCents: number }[]
  stripeCustomerId: string
  payment: { receivedAt: Date }
  reference: string
  instrument: string
  idempotencyKey: string
  logTag: string
}): Promise<{ landed: string[]; landedCents: number }> {
  let landedCents = 0
  const landed: string[] = []
  for (const split of input.splits) {
    try {
      await input.provider.recordOutOfBandPayment({
        stripeInvoiceId: split.stripeInvoiceId,
        stripeCustomerId: input.stripeCustomerId,
        amountCents: split.amountCents,
        receivedAt: input.payment.receivedAt,
        reference: input.reference,
        instrument: input.instrument,
        idempotencyKey: `${input.idempotencyKey}:${split.stripeInvoiceId}`,
      })
    } catch (error) {
      console.error(`[${input.logTag}] out-of-band push failed on ${split.stripeInvoiceId}`, error)
      break
    }
    landedCents += split.amountCents
    landed.push(split.stripeInvoiceId)
  }
  return { landed, landedCents }
}
