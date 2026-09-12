// The repayment agreement a tenant signs (PAY-08/LEASE-06, R-203). Pure -
// what the page SAYS. Drawing it is apps/web/lib/pdf/render.ts, the same
// split every other printable artifact here uses.
//
// ==========================================================================
// WHAT R-199 ALREADY PROVES, AND WHAT THIS ADDS.
//
// R-199's Notification rows prove the schedule was SENT: the whole
// instalment table, to everybody the chase would write to, at a recorded
// moment. That answers "we were never told". It does not answer "I never
// agreed to that", and a broken plan is argued from the second one.
//
// So the document is deliberately not a prettier copy of the email. It says,
// in the tenant's own words back to them, the four things that get disputed
// after a plan falls apart: what the arrears actually were on the day, what
// the instalments are, that the ordinary rent is STILL DUE on top, and what
// happens when an instalment is missed.
// ==========================================================================
//
// THE RENT SENTENCE IS LOAD-BEARING AND MUST NOT BE SOFTENED. Since R-187 a
// plan is only kept when the new rent is paid too, so a tenant who reads
// this as "pay the instalments instead of the rent" would break the plan by
// doing exactly what the paper told them. `payment_plan.agreed`'s own
// template carries the same sentence for the same reason; they are two
// copies on purpose, because the document outlives the email.

import { type Column, type DocumentBlock, padColumns } from '../documents/blocks.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { type BusinessDate, friendlyBusinessDate } from '../scheduling/local-time.ts'
import { PLAN_GRACE_DAYS } from './plan.ts'

/// Three columns, sized the way DEPOSIT_SLIP_COLUMNS states its own: they
/// sum, with single-space gaps, to comfortably inside the renderer's
/// MONO_LINE_CHARS at its default mono size.
export const PLAN_SCHEDULE_COLUMNS: readonly Column[] = [
  { width: 16 },
  { width: 20 },
  { width: 14, align: 'right' },
]
export const PLAN_SCHEDULE_GAP = 2
export const PLAN_SCHEDULE_WIDTH =
  PLAN_SCHEDULE_COLUMNS.reduce((sum, column) => sum + column.width, 0) +
  PLAN_SCHEDULE_GAP * (PLAN_SCHEDULE_COLUMNS.length - 1)

/// Same posture as LEASE_DISCLAIMER: this product generates the paper and
/// does not give legal advice about it.
export const PLAN_DISCLAIMER =
  'This agreement was generated from the records of this system and has not been reviewed by an attorney for compliance in this jurisdiction. It is not legal advice.'

export const PLAN_RENT_STILL_DUE =
  'The ordinary rent remains due in full, on its usual day, for every month of this plan. The instalments below are in addition to it, and the plan counts as kept only when both are paid.'

export const PLAN_NOT_A_WAIVER =
  'This agreement changes when the arrears are paid. It does not reduce or forgive them, and it is not a new tenancy, a renewal, or a change to any other term of the lease.'

export interface PlanSignatureFact {
  order: number
  role: 'TENANT' | 'GUARANTOR'
  name: string
  /// Pre-formatted by the caller, the same way LeaseSignatureFact's is -
  /// this module never reads a date out of an instant.
  signedAt: string | null
  signedName: string | null
}

export interface PaymentPlanDocumentFacts {
  propertyName: string
  propertyAddress: string
  unitName: string
  entityName: string
  tenantNames: readonly string[]
  /// The arrears the plan repays, snapshotted when it was agreed - not the
  /// balance today. `PaymentPlan.arrearsCents`'s own comment says why.
  arrearsCents: Cents
  agreedOn: BusinessDate
  generatedOn: BusinessDate
  /// What was agreed in words, as the operator typed it. Quoted rather than
  /// paraphrased: "she starts the new job on the 14th" is the fact the next
  /// conversation turns on, and rewording somebody's own account of their
  /// circumstances into house style is how it stops being evidence.
  note: string
  instalments: readonly { sequence: number; dueOn: BusinessDate; amountCents: Cents }[]
  signers: readonly PlanSignatureFact[]
}

/**
 * The blocks a repayment agreement is made of, in order: title, the parties
 * and the property, what is owed, the schedule as an aligned table, the four
 * clauses that get disputed, a signature block, and the standing disclaimer.
 *
 * Used for BOTH the unsigned draft and the executed PDF - `signers` carries
 * blank `signedAt`/`signedName` for the draft, the same call
 * `leaseDocumentBlocks` makes.
 */
export function paymentPlanDocumentBlocks(facts: PaymentPlanDocumentFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [{ kind: 'heading', text: 'Repayment Agreement' }]

  blocks.push({ kind: 'meta', text: `Date prepared: ${friendlyBusinessDate(facts.generatedOn)}` })
  blocks.push({ kind: 'meta', text: `Agreed: ${friendlyBusinessDate(facts.agreedOn)}` })
  blocks.push({ kind: 'meta', text: `Property: ${facts.propertyName} — ${facts.unitName}` })
  blocks.push({ kind: 'meta', text: `Address: ${facts.propertyAddress}` })
  blocks.push({ kind: 'meta', text: `Landlord: ${facts.entityName}` })
  blocks.push({ kind: 'meta', text: `Resident(s): ${facts.tenantNames.join(', ')}` })
  blocks.push({ kind: 'meta', text: `Arrears covered by this plan: ${formatCents(facts.arrearsCents)}` })

  blocks.push({
    kind: 'paragraph',
    text: `The parties agree that ${formatCents(facts.arrearsCents)} of rent and other charges is owed at the property described above as at ${friendlyBusinessDate(facts.agreedOn)}, and that it will be repaid on the schedule set out below.`,
  })
  blocks.push({ kind: 'paragraph', text: `What was agreed, as recorded at the time: “${facts.note}”` })

  blocks.push({ kind: 'subheading', text: 'The schedule' })
  blocks.push({
    kind: 'mono',
    text: padColumns(['Instalment', 'Falls due', 'Amount'], PLAN_SCHEDULE_COLUMNS, PLAN_SCHEDULE_GAP),
  })
  const total = facts.instalments.reduce((sum, instalment) => sum + instalment.amountCents, 0)
  for (const instalment of facts.instalments) {
    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          `${instalment.sequence} of ${facts.instalments.length}`,
          friendlyBusinessDate(instalment.dueOn),
          formatCents(instalment.amountCents),
        ],
        PLAN_SCHEDULE_COLUMNS,
        PLAN_SCHEDULE_GAP,
      ),
    })
  }
  blocks.push({
    kind: 'mono',
    text: [
      '-'.repeat(PLAN_SCHEDULE_WIDTH),
      padColumns(['', 'Total', formatCents(total)], PLAN_SCHEDULE_COLUMNS, PLAN_SCHEDULE_GAP),
    ].join('\n'),
  })

  blocks.push({ kind: 'subheading', text: 'The rent is still due' })
  blocks.push({ kind: 'paragraph', text: PLAN_RENT_STILL_DUE })

  blocks.push({ kind: 'subheading', text: 'While this plan is kept' })
  blocks.push({
    kind: 'paragraph',
    text: 'Overdue-rent reminders and late fees on the arrears above are paused for as long as the plan is kept.',
  })

  blocks.push({ kind: 'subheading', text: 'If an instalment is missed' })
  blocks.push({
    kind: 'paragraph',
    text: `If the payments fall behind this schedule by more than ${PLAN_GRACE_DAYS} days after an instalment date, the plan ends, the pause above ends with it, and ordinary collection resumes on the whole of what is then owed.`,
  })

  blocks.push({ kind: 'subheading', text: 'What this agreement does not do' })
  blocks.push({ kind: 'paragraph', text: PLAN_NOT_A_WAIVER })

  blocks.push({ kind: 'subheading', text: 'Signatures' })
  for (const signer of facts.signers) {
    const label = signer.role === 'TENANT' ? 'Resident' : 'Guarantor'
    blocks.push({
      kind: 'meta',
      text: signer.signedAt
        ? `${label} ${signer.order}: ${signer.signedName ?? signer.name} — signed electronically ${signer.signedAt}`
        : `${label} ${signer.order}: ${signer.name} — not yet signed`,
    })
  }

  blocks.push({ kind: 'footer', text: PLAN_DISCLAIMER })

  return blocks
}
