import 'server-only'

import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'

// R-291b (PRD 10 §5 step 9, D-384): the owner's $1 test invoice. Billed on the
// org's own Stripe account and paid on Stripe's hosted page; the paid event is
// the only writer of `SetupTestPayment`, which step 9 reads.

export const SETUP_TEST_CENTS = 100

/// From the pipeline, once per invoice: a redelivery finds the row there.
export async function recordSetupTestPayment(
  orgId: string,
  paid: { stripeInvoiceId: string; amountCents: number; occurredAt: Date },
  stripeEventId: string,
): Promise<string> {
  try {
    await prisma.setupTestPayment.create({
      data: { orgId, stripeInvoiceId: paid.stripeInvoiceId, amountCents: paid.amountCents, paidAt: paid.occurredAt, stripeEventId },
    })
    return `setup test payment ${paid.amountCents} on ${paid.stripeInvoiceId}`
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return `setup test payment ${paid.stripeInvoiceId} already recorded`
  }
}
