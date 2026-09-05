// The counter receipt handed over (or reprinted) at the moment of payment
// (PAY-05's own named leftover, R-166).
//
// A DIFFERENT ARTIFACT FOR A DIFFERENT MOMENT, not a copy of the ordinary
// payment receipt. The tenant gets that one once the webhook posts and the
// ledger moves - proof the payment was PROCESSED. This one prints at the
// counter, before any of that has happened, and its only job is proof the
// payment was HANDED OVER: what arrived, to whom, and when. See
// `apps/web/lib/payments/offline.ts`'s own header for why the two moments
// are already treated as distinct in the write path this reads from.

import { type DocumentBlock } from '../documents/blocks.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { depositChannelLabel } from './deposit-slip-document.ts'

export interface ReceiptFacts {
  entityName: string
  propertyName: string
  unitName: string
  payerName: string
  amountCents: Cents
  channel: string
  checkNumber: string | null
  receivedOn: string
  receivedByName: string
  generatedAt: string
}

export const RECEIPT_DISCLAIMER =
  'This receipt confirms money was handed over and recorded. It is not proof the payment has posted to the ledger - that happens once the billing provider confirms it.'

export function receiptBlocks(facts: ReceiptFacts): DocumentBlock[] {
  return [
    { kind: 'heading', text: 'PAYMENT RECEIPT' },
    { kind: 'meta', text: `Landlord: ${facts.entityName}` },
    { kind: 'meta', text: `Property: ${facts.propertyName} — ${facts.unitName}` },
    { kind: 'meta', text: `Received from: ${facts.payerName}` },
    { kind: 'meta', text: `Amount: ${formatCents(facts.amountCents)}` },
    {
      kind: 'meta',
      text:
        facts.channel === 'OFFLINE_CHECK' && facts.checkNumber
          ? `Paid by: Check #${facts.checkNumber}`
          : `Paid by: ${depositChannelLabel(facts.channel)}`,
    },
    { kind: 'meta', text: `Date received: ${facts.receivedOn}` },
    { kind: 'meta', text: `Received by: ${facts.receivedByName}` },
    { kind: 'meta', text: `Printed: ${facts.generatedAt}` },
    { kind: 'footer', text: RECEIPT_DISCLAIMER },
  ]
}
