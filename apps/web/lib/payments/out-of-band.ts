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

  const { landed, landedCents } = await pushSplits({ ...input, paymentId: payment.id, splits })

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
 *
 * A PUSH THAT THROWS IS NOT A PUSH THAT FAILED (MONEY-11). A timeout on
 * Stripe's response throws after the record was written, and its echo is
 * already on the way. That split is kept, unstamped, and reported as
 * `unconfirmedCents`; deleting it sent the echo to `writePayment`, which
 * credited the same money twice. Only splits never attempted are backed out.
 */
export async function applyPortalPayment(input: {
  provider: BillingProvider
  paymentId: string
  stripeCustomerId: string
  stripePaymentIntentId: string
  principalCents: number
  receivedAt: Date
}): Promise<{ appliedCents: number; unconfirmedCents: number }> {
  // A REPLAY (MONEY-12). Splits already here mean an earlier run of this same
  // event got as far as the push, and what it sent is not knowable from here.
  // Pushing again would apply the money to the invoice twice once Stripe's
  // idempotency key has aged out, so report what is known and leave the rest
  // to the drift sweep.
  const prior = await prisma.paymentInvoiceSplit.findMany({
    where: { paymentId: input.paymentId },
    select: { amountCents: true, pushedAt: true, claimedByEventId: true },
  })
  if (prior.length > 0) {
    const sum = (rows: typeof prior) => rows.reduce((total, row) => total + row.amountCents, 0)
    const known = prior.filter((row) => row.pushedAt != null || row.claimedByEventId != null)
    return { appliedCents: sum(known), unconfirmedCents: sum(prior) - sum(known) }
  }

  const invoices = await input.provider.getOpenInvoices({ stripeCustomerId: input.stripeCustomerId })
  if (!invoices) throw new Error(`could not list open invoices for ${input.stripeCustomerId}`)
  const open = invoices.reduce((total, invoice) => total + invoice.amountRemainingCents, 0)
  // ponytail: money beyond the open invoices (a prepayment) stays a ledger
  // credit Stripe cannot see, so next month's invoice is collected in full.
  const splits = splitAcrossInvoices(Math.min(input.principalCents, open), invoices)
  if (splits.length === 0) return { appliedCents: 0, unconfirmedCents: 0 }

  await prisma.paymentInvoiceSplit.createMany({
    data: splits.map((split) => ({ ...split, paymentId: input.paymentId })),
  })
  const { landed, landedCents, threw } = await pushSplits({
    provider: input.provider,
    paymentId: input.paymentId,
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
      where: {
        paymentId: input.paymentId,
        stripeInvoiceId: { notIn: threw ? [...landed, threw.stripeInvoiceId] : landed },
      },
    })
  }
  return { appliedCents: landedCents, unconfirmedCents: threw?.amountCents ?? 0 }
}

/// How long a split with no `pushedAt` may still claim an echo (MONEY-12).
/// The push is one synchronous call inside one request, so a real echo is
/// seconds behind its split; ten minutes is longer than any function lives.
/// Past it, a split nobody stamped is a push that died or was refused, and
/// the next `invoice.updated` of its amount is somebody's money.
export const UNPUSHED_CLAIM_WINDOW_MS = 10 * 60_000

/// One push per split, oldest first, stopping at the first refusal: what
/// landed is real money at Stripe, what did not is the caller's to back out.
/// `threw` is the one split whose push threw - Stripe may hold it or not.
async function pushSplits(input: {
  provider: BillingProvider
  paymentId: string
  splits: readonly { stripeInvoiceId: string; amountCents: number }[]
  stripeCustomerId: string
  payment: { receivedAt: Date }
  reference: string
  instrument: string
  idempotencyKey: string
  logTag: string
}): Promise<{
  landed: string[]
  landedCents: number
  threw: { stripeInvoiceId: string; amountCents: number } | null
}> {
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
      return { landed, landedCents, threw: split }
    }
    landedCents += split.amountCents
    landed.push(split.stripeInvoiceId)
    // Swallowed: the push landed and that is the fact. A split left unstamped
    // has usually claimed its echo already, and otherwise shows up as drift.
    await prisma.paymentInvoiceSplit
      .updateMany({
        where: { paymentId: input.paymentId, stripeInvoiceId: split.stripeInvoiceId },
        data: { pushedAt: new Date() },
      })
      .catch((stampError) => {
        console.error(`[${input.logTag}] could not stamp push of ${split.stripeInvoiceId}`, stampError)
      })
  }
  return { landed, landedCents, threw: null }
}
