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

  let landedCents = 0
  const landed: string[] = []
  for (const split of splits) {
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
