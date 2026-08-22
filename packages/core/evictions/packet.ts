// The attorney packet's own cover sheet and exhibit index (PAY-14, R-083).
//
// The packet is mostly OTHER DOCUMENTS - the statement of account, the
// communications transcript, each notice with its proof of service, the
// executed lease, the photographs. Those already exist as archived artifacts
// and are appended whole (`appendPdfs`, D-50). What this file builds is the
// two pages that go in front of them: what this case is, and what is
// actually in the bundle.
//
// THE INDEX IS THE POINT. D-50 settled the rule when the statement started
// embedding the payment provider's invoices: never silently drop an
// attachment, always name what could not be included. An attorney packet
// that quietly omitted the one photograph that would not parse is worse than
// one that never claimed to have photographs - and this bundle carries far
// more attachments than that statement ever did.
//
// The index itself now lives in `documents/exhibits.ts`, moved there by
// R-081d when the tax packet needed the identical thing. `PacketExhibit` is
// re-exported below so nothing that imported it from here had to change.

import type { DocumentBlock } from '../documents/blocks.ts'
import { type PacketExhibit, exhibitIndexBlocks } from '../documents/exhibits.ts'
import { formatCents } from '../money/money.ts'
import { EVICTION_COST_LABELS, isEvictionCostType, type CostTotals } from './costs.ts'
import { CURE_STATE_LABELS, type CureClock } from './cure.ts'
import {
  EVICTION_OUTCOME_LABELS,
  EVICTION_STAGE_LABELS,
  isEvictionOutcome,
  type EvictionStageValue,
} from './stages.ts'

/// D-4's standing requirement, in the form this artifact needs. Deliberately
/// its own sentence rather than an import of `NOTICE_DISCLAIMER`: that one
/// says "this notice is a draft", which is not what a packet of already-served
/// evidence is. The claim being disclaimed here is different - the bundle is
/// real, the legal conclusion it might support is not ours to draw.
export const PACKET_DISCLAIMER =
  'This packet was assembled automatically from records held in this system. It is not legal advice, no part of it has been filed with any court by this system, and nothing in it has been reviewed by an attorney for this matter.'

export type { PacketExhibit }

export interface PacketFacts {
  propertyName: string
  addressLine1: string
  unitName: string | null
  tenantNames: readonly string[]
  stage: EvictionStageValue
  outcome: string | null
  openedOn: string
  closedOn: string | null
  filedOn: string | null
  courtDate: string | null
  judgmentOn: string | null
  writOn: string | null
  lockoutOn: string | null
  clock: CureClock
  costs: CostTotals
  ledgerBalanceCents: number | null
  exhibits: readonly PacketExhibit[]
  generatedAt: string
  generatedBy: string
  timezone: string
}

const COLUMN_LABEL = 34
const COLUMN_AMOUNT = 14

export function packetBlocks(facts: PacketFacts): DocumentBlock[] {
  const where = facts.unitName ? `${facts.propertyName} — ${facts.unitName}` : facts.propertyName

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'EVICTION CASE FILE' },
    { kind: 'meta', text: `Property: ${where}` },
    { kind: 'meta', text: `Address: ${facts.addressLine1}` },
    {
      kind: 'meta',
      text: `Tenant${facts.tenantNames.length === 1 ? '' : 's'}: ${
        facts.tenantNames.length > 0 ? facts.tenantNames.join(', ') : 'Not recorded'
      }`,
    },
    { kind: 'meta', text: `Case opened: ${facts.openedOn}` },
    { kind: 'meta', text: `Current stage: ${EVICTION_STAGE_LABELS[facts.stage]}` },
  ]

  if (facts.outcome) {
    blocks.push({
      kind: 'meta',
      text: `Outcome: ${
        isEvictionOutcome(facts.outcome) ? EVICTION_OUTCOME_LABELS[facts.outcome] : facts.outcome
      }${facts.closedOn ? ` (${facts.closedOn})` : ''}`,
    })
  }

  blocks.push({ kind: 'subheading', text: 'Service and the cure period' })
  blocks.push({ kind: 'paragraph', text: CURE_STATE_LABELS[facts.clock.state] })
  if (facts.clock.runsFrom) {
    blocks.push({ kind: 'meta', text: `Cure period runs from: ${facts.clock.runsFrom}` })
  }
  if (facts.clock.cureBy) {
    blocks.push({ kind: 'meta', text: `Last day to cure: ${facts.clock.cureBy}` })
  } else if (facts.clock.periodUnknown) {
    // Named, never guessed - the caller has no configured cure period for
    // this state and a number invented here is the one that gets a case
    // dismissed.
    blocks.push({
      kind: 'meta',
      text: 'Last day to cure: not configured for this jurisdiction in this system',
    })
  }

  const courtDates: [string, string | null][] = [
    ['Filed', facts.filedOn],
    ['Court date', facts.courtDate],
    ['Judgment', facts.judgmentOn],
    ['Writ of possession', facts.writOn],
    ['Lockout', facts.lockoutOn],
  ]
  const recorded = courtDates.filter(([, value]) => value !== null)
  if (recorded.length > 0) {
    blocks.push({ kind: 'subheading', text: 'Case dates' })
    for (const [label, value] of recorded) {
      blocks.push({ kind: 'meta', text: `${label}: ${value}` })
    }
  }

  blocks.push({ kind: 'subheading', text: 'Costs incurred by the owner' })
  if (facts.costs.totalCents === 0) {
    blocks.push({ kind: 'paragraph', text: 'No costs recorded.' })
  } else {
    for (const [type, cents] of Object.entries(facts.costs.byType)) {
      const label = isEvictionCostType(type) ? EVICTION_COST_LABELS[type] : type
      blocks.push({
        kind: 'mono',
        text: padRow(label, formatCents(cents)),
      })
    }
    blocks.push({ kind: 'mono', text: padRow('TOTAL', formatCents(facts.costs.totalCents)) })
  }

  // The ledger's own number, printed here as a pointer to the statement
  // rather than restated as a second figure - see LOST_RENT_IS_DERIVED.
  if (facts.ledgerBalanceCents != null) {
    blocks.push({
      kind: 'paragraph',
      text: `Rent outstanding is not listed above. The statement of account included in this packet carries the balance, which stood at ${formatCents(
        facts.ledgerBalanceCents,
      )} when this packet was produced.`,
    })
  }

  blocks.push({ kind: 'subheading', text: 'Exhibits' })
  blocks.push(...exhibitIndexBlocks(facts.exhibits, 'No exhibits were available to attach.'))

  blocks.push({ kind: 'footer', text: `Produced ${facts.generatedAt} (${facts.timezone}) by ${facts.generatedBy}` })
  blocks.push({ kind: 'footer', text: PACKET_DISCLAIMER })

  return blocks
}

function padRow(label: string, amount: string): string {
  const left = label.length > COLUMN_LABEL ? `${label.slice(0, COLUMN_LABEL - 1)}…` : label.padEnd(COLUMN_LABEL)
  return `${left}${amount.padStart(COLUMN_AMOUNT)}`
}
