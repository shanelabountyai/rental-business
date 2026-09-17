// The deposit-dispute packet's own cover sheet (INSP-03/INSP-05/PAY-11, R-218).
//
// R-083's attorney packet, for the case a small operator actually ends up in
// court over. Most of the file is OTHER documents appended whole - the
// disposition letter, its proof of service, the refund proof, the lease, the
// invoices and photographs. What this builds is the pages in front of them:
// the dates, the per-item move-in/move-out comparison, and each deduction
// with its evidence AND the depreciation guidance that was or was not applied.
// That last part is what a hand-assembled packet reliably misses.
//
// Every date arrives as a raw `BusinessDate` and is formatted HERE, so a
// caller cannot hand a tenant-facing sentence a `2026-08-01` (D-153).

import type { DocumentBlock } from '../documents/blocks.ts'
import { type PacketExhibit, exhibitIndexBlocks } from '../documents/exhibits.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { type BusinessDate, friendlyBusinessDate } from '../scheduling/local-time.ts'
import { depreciationGuidance, isUnsupportedDeduction } from './disposition.ts'

/// D-4's disclaimer in the shape this artifact needs - the same claim
/// `PACKET_DISCLAIMER` makes for the eviction file.
export const DEPOSIT_PACKET_DISCLAIMER =
  'This packet was assembled automatically from records held in this system. It is not legal advice, no part of it has been filed with any court by this system, and nothing in it has been reviewed by an attorney for this matter.'

export interface DepositPacketDeduction {
  description: string
  amountCents: Cents
  workOrderScope: string | null
  /// The move-out checklist row this deduction rests on, with its move-in
  /// counterpart's condition when the two were paired (R-070).
  inspectionItem: {
    room: string
    item: string
    moveInCondition: string | null
    moveOutCondition: string | null
  } | null
  evidenceFileCount: number
  estimatedAgeYears: number | null
  usefulLifeYears: number | null
}

export interface DepositPacketFacts {
  propertyName: string
  addressLine1: string
  unitName: string | null
  tenantNames: readonly string[]
  moveOutOn: BusinessDate | null
  heldCents: Cents
  receivedOn: BusinessDate | null
  dispositionDueOn: BusinessDate | null
  dispositionSentOn: BusinessDate | null
  forwardingAddress: string | null
  /// Each recorded service of the disposition letter, already labelled.
  service: readonly { methodLabel: string; servedOn: BusinessDate }[]
  appliedCents: Cents
  refundedCents: Cents
  refundPaidOn: BusinessDate | null
  refundMethodLabel: string | null
  refundReference: string | null
  moveIn: {
    performedOn: BusinessDate | null
    tenantSignedOn: BusinessDate | null
  } | null
  moveOut: { performedOn: BusinessDate | null } | null
  comparison: readonly {
    room: string
    item: string
    moveInCondition: string | null
    moveOutCondition: string | null
  }[]
  deductions: readonly DepositPacketDeduction[]
  exhibits: readonly PacketExhibit[]
  generatedAt: string
  generatedBy: string
  timezone: string
}

const COLUMN_LABEL = 34
const COLUMN_AMOUNT = 14

export function depositPacketBlocks(facts: DepositPacketFacts): DocumentBlock[] {
  const where = facts.unitName ? `${facts.propertyName} — ${facts.unitName}` : facts.propertyName
  const day = (value: BusinessDate | null) => (value ? friendlyBusinessDate(value) : 'Not recorded')

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'SECURITY DEPOSIT DISPUTE FILE' },
    { kind: 'meta', text: `Property: ${where}` },
    { kind: 'meta', text: `Address: ${facts.addressLine1}` },
    {
      kind: 'meta',
      text: `Tenant${facts.tenantNames.length === 1 ? '' : 's'}: ${
        facts.tenantNames.length > 0 ? facts.tenantNames.join(', ') : 'Not recorded'
      }`,
    },
    {
      kind: 'meta',
      text: `Deposit held: ${formatCents(facts.heldCents)} (received ${day(facts.receivedOn)})`,
    },
    { kind: 'meta', text: `Moved out: ${day(facts.moveOutOn)}` },
  ]

  blocks.push({ kind: 'subheading', text: 'Dates' })
  blocks.push({
    kind: 'meta',
    text: `Disposition due: ${day(facts.dispositionDueOn)}`,
  })
  blocks.push({
    kind: 'meta',
    text: `Disposition letter written: ${
      facts.dispositionSentOn
        ? friendlyBusinessDate(facts.dispositionSentOn)
        : 'Not yet — no disposition has been finalized'
    }${lateness(facts.dispositionSentOn, facts.dispositionDueOn)}`,
  })
  blocks.push({
    kind: 'meta',
    text: `Forwarding address used: ${facts.forwardingAddress ?? 'Not recorded'}`,
  })
  if (facts.service.length === 0) {
    // The awkward fact is named, never omitted (D-50): a letter with no
    // recorded service is the first thing a former tenant's claim turns on.
    blocks.push({
      kind: 'paragraph',
      text: 'No service of the disposition letter is recorded.',
    })
  } else {
    for (const service of facts.service) {
      blocks.push({
        kind: 'meta',
        text: `Served: ${friendlyBusinessDate(service.servedOn)} — ${service.methodLabel}${lateness(service.servedOn, facts.dispositionDueOn)}`,
      })
    }
  }
  if (facts.refundedCents > 0) {
    blocks.push({
      kind: 'meta',
      text: facts.refundPaidOn
        ? `Refund paid: ${friendlyBusinessDate(facts.refundPaidOn)} — ${facts.refundMethodLabel ?? 'method not recorded'}${
            facts.refundReference ? `, reference ${facts.refundReference}` : ''
          }${lateness(facts.refundPaidOn, facts.dispositionDueOn)}`
        : 'Refund paid: not recorded as paid',
    })
  }

  blocks.push({ kind: 'subheading', text: 'Totals' })
  const deductedCents = facts.deductions.reduce((sum, d) => sum + d.amountCents, 0)
  blocks.push({
    kind: 'mono',
    text: padRow('Deposit held', formatCents(facts.heldCents)),
  })
  blocks.push({
    kind: 'mono',
    text: padRow('Itemized deductions', formatCents(deductedCents)),
  })
  if (facts.dispositionSentOn) {
    blocks.push({
      kind: 'mono',
      text: padRow('Kept against the deposit', formatCents(facts.appliedCents)),
    })
    blocks.push({
      kind: 'mono',
      text: padRow('Refunded', formatCents(facts.refundedCents)),
    })
  }

  blocks.push({
    kind: 'subheading',
    text: 'Condition at move-in and move-out',
  })
  blocks.push({
    kind: 'meta',
    text: facts.moveIn
      ? `Move-in inspection: ${day(facts.moveIn.performedOn)}; ${
          facts.moveIn.tenantSignedOn
            ? `signed by the tenant ${friendlyBusinessDate(facts.moveIn.tenantSignedOn)}`
            : 'not signed by the tenant'
        }`
      : 'Move-in inspection: none on record',
  })
  blocks.push({
    kind: 'meta',
    text: facts.moveOut
      ? `Move-out inspection: ${day(facts.moveOut.performedOn)}`
      : 'Move-out inspection: none on record',
  })
  for (const row of facts.comparison) {
    const changed = row.moveInCondition !== row.moveOutCondition
    blocks.push({
      kind: 'mono',
      text: `${`${row.room} — ${row.item}`.padEnd(COLUMN_LABEL).slice(0, COLUMN_LABEL)} ${condition(row.moveInCondition)} -> ${condition(row.moveOutCondition)}${changed ? '  *' : ''}`,
    })
  }
  if (facts.comparison.some((row) => row.moveInCondition !== row.moveOutCondition)) {
    blocks.push({
      kind: 'paragraph',
      text: '* condition differs between move-in and move-out.',
    })
  }

  blocks.push({ kind: 'subheading', text: 'Deductions and their evidence' })
  if (facts.deductions.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No deductions were made.' })
  }
  for (const deduction of facts.deductions) {
    blocks.push({
      kind: 'mono',
      text: padRow(deduction.description, formatCents(deduction.amountCents)),
    })

    const evidence: string[] = []
    if (deduction.workOrderScope) evidence.push(`work order "${deduction.workOrderScope}"`)
    if (deduction.inspectionItem) {
      const item = deduction.inspectionItem
      evidence.push(
        `move-out item ${item.room} — ${item.item} (move-in ${condition(item.moveInCondition)}, move-out ${condition(item.moveOutCondition)})`,
      )
    }
    if (deduction.evidenceFileCount > 0) {
      evidence.push(`${deduction.evidenceFileCount} attached file${deduction.evidenceFileCount === 1 ? '' : 's'}`)
    }
    const unsupported = isUnsupportedDeduction({
      workOrderId: deduction.workOrderScope,
      inspectionItemId: deduction.inspectionItem ? 'linked' : null,
      evidenceDocumentCount: deduction.evidenceFileCount,
    })
    blocks.push({
      kind: 'meta',
      text: unsupported ? 'Evidence: none linked — this deduction is unsupported.' : `Evidence: ${evidence.join('; ')}`,
    })

    if (deduction.estimatedAgeYears != null && deduction.usefulLifeYears != null) {
      const guidance = depreciationGuidance(
        deduction.amountCents,
        deduction.estimatedAgeYears,
        deduction.usefulLifeYears,
      )
      blocks.push({
        kind: 'meta',
        text: `Depreciation: ${deduction.estimatedAgeYears} years old, of a ${deduction.usefulLifeYears}-year useful life; age-based guidance is at most ${formatCents(
          guidance.suggestedMaxCents,
        )}. The amount claimed ${guidance.exceedsGuidance ? 'EXCEEDS' : 'is within'} that guidance.`,
      })
    } else {
      blocks.push({
        kind: 'meta',
        text: 'Depreciation: no age or useful life was recorded, so no age-based guidance was applied.',
      })
    }
  }

  blocks.push({ kind: 'subheading', text: 'Exhibits' })
  blocks.push(...exhibitIndexBlocks(facts.exhibits, 'No exhibits were available to attach.'))

  blocks.push({
    kind: 'footer',
    text: `Produced ${facts.generatedAt} (${facts.timezone}) by ${facts.generatedBy}`,
  })
  blocks.push({ kind: 'footer', text: DEPOSIT_PACKET_DISCLAIMER })

  return blocks
}

/// A plain comparison of two calendar days, printed as a fact rather than a
/// legal conclusion. String order is day order for `YYYY-MM-DD` (D-3).
function lateness(on: BusinessDate | null, dueOn: BusinessDate | null): string {
  return on && dueOn && on > dueOn ? ' (after the disposition due date)' : ''
}

function condition(value: string | null): string {
  return value ? value.charAt(0) + value.slice(1).toLowerCase() : 'Not rated'
}

function padRow(label: string, amount: string): string {
  const left = label.length > COLUMN_LABEL ? `${label.slice(0, COLUMN_LABEL - 1)}…` : label.padEnd(COLUMN_LABEL)
  return `${left}${amount.padStart(COLUMN_AMOUNT)}`
}
