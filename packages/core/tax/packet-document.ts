// The year-end tax packet as a printable artifact (RPT-07, R-081d).
//
// WHY THIS IS ARCHIVED RATHER THAN REGENERATED. R-081b's screen and CSV answer
// "what do the books say now". A packet answers a different question: what did
// we hand the preparer in February. The underlying rows keep moving - a
// corrected 1098 is upserted, a late invoice is paid, a deposit is disposed of
// - so a packet regenerated in June is a different document, and "which one
// did the CPA file from" then has no answer. Same reasoning R-052 wrote down
// for the ledger statement and R-083 for the attorney packet.
//
// NO NEW MONEY MATH HERE. Every figure is already computed by `packet.ts`,
// which is itself a regrouping of R-078's export lines (D-72). This file lays
// them on a page. A second arithmetic path to the same numbers would be a
// second chance to get a sign or a timezone wrong, and both are silent when
// wrong.

import { type DocumentBlock, padColumns } from '../documents/blocks.ts'
import { type PacketExhibit, exhibitIndexBlocks } from '../documents/exhibits.ts'
import { formatCents } from '../money/money.ts'
import type { ExportLine } from './export.ts'
import type { Form1099Candidate, PropertyDepositLiability, PropertyScheduleE } from './packet.ts'

/// D-4's standing requirement in the form this artifact needs, and
/// deliberately its own sentence rather than the eviction packet's: what is
/// being disclaimed is not a legal conclusion but a TAX one. The numbers are
/// the owner's own books; the return is the preparer's.
export const TAX_PACKET_DISCLAIMER =
  'This packet was assembled automatically from records held in this system. It is bookkeeping, not tax advice, and no part of it has been reviewed by a tax preparer. Nothing here has been filed with any taxing authority by this system.'

/// The lines that STILL have no source in this product, carried on the
/// artifact and not only on the screen. A missing expense line reads as a
/// zero and a zero overstates income - which is R-078's own reasoning, and it
/// matters more on a PDF handed to somebody than on a page they can ask about.
export const UNFILLABLE_NOTE =
  'Schedule E lines this product cannot fill at all: advertising (line 5), auto and travel (6), cleaning and maintenance beyond recorded jobs (7), commissions (8), insurance (9), legal and professional fees beyond recorded eviction costs (10), management fees (11), other interest (13), supplies (15) and taxes (16). Nothing in this system records them, so they are absent rather than zero.'

const COLUMN_LABEL = 46
const COLUMN_AMOUNT = 14

export interface TaxPacketDocumentFacts {
  legalEntityName: string
  year: number
  /// 'cash' or 'accrual'. On the artifact because the SAME work order books
  /// in two different tax years depending on it (D-71) - a packet that did
  /// not say which basis produced it is a packet nobody can reconcile.
  basis: string
  scheduleE: readonly PropertyScheduleE[]
  capex: readonly ExportLine[]
  depositLiability: {
    byProperty: readonly PropertyDepositLiability[]
    totalCents: number
  }
  vendors: readonly Form1099Candidate[]
  exceptions: readonly ExportLine[]
  exceptionCents: number
  exhibits: readonly PacketExhibit[]
  generatedAt: string
  generatedBy: string
  timezone: string
}

export function taxPacketBlocks(facts: TaxPacketDocumentFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'YEAR-END TAX PACKET' },
    { kind: 'meta', text: `Legal entity: ${facts.legalEntityName}` },
    { kind: 'meta', text: `Tax year: ${facts.year}` },
    {
      kind: 'meta',
      text: `Basis: ${facts.basis === 'accrual' ? 'Accrual — when it was billed' : 'Cash — when money moved'}`,
    },
  ]

  // ==========================================================================
  // Schedule E, per property. The form has a column per address, which is why
  // this is the grouping on the artifact even though R-078's export totals per
  // entity for a QuickBooks import (both are right for their own reader).
  // ==========================================================================
  blocks.push({ kind: 'subheading', text: 'Schedule E — by property' })
  if (facts.scheduleE.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No properties to report on.' })
  } else {
    for (const property of facts.scheduleE) {
      blocks.push({ kind: 'meta', text: property.propertyName })
      if (property.totals.length === 0) {
        blocks.push({ kind: 'paragraph', text: 'Nothing booked to a Schedule E line this year.' })
        continue
      }
      for (const total of property.totals) {
        blocks.push({ kind: 'mono', text: row(`  Line ${total.line} · ${total.label}`, total.amountCents) })
      }
      blocks.push({ kind: 'mono', text: row('  NET', property.netCents) })
    }
  }
  blocks.push({ kind: 'paragraph', text: UNFILLABLE_NOTE })

  blocks.push({ kind: 'subheading', text: 'Capital improvements placed in service' })
  if (facts.capex.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'None placed in service this year.' })
  } else {
    for (const line of facts.capex) {
      blocks.push({
        kind: 'mono',
        text: row(`${line.propertyName} · ${line.description}`, line.amountCents),
      })
      blocks.push({ kind: 'mono', text: `  In service ${line.bookedOn ?? 'not recorded'}` })
    }
    // Depreciation is the preparer's call - method, recovery period and
    // convention are all theirs, and a number invented here would be a
    // deduction this product claimed on somebody's return.
    blocks.push({
      kind: 'paragraph',
      text: 'This is the input to Schedule E line 18, not line 18 itself. Depreciation is deliberately not computed here.',
    })
  }

  blocks.push({ kind: 'subheading', text: `Security deposit liability at 31 December ${facts.year}` })
  blocks.push({
    kind: 'paragraph',
    text: 'Money still owed back to tenants — a balance on a date, not deposits received during the year. A deposit disposed of after 31 December was still held in full on that date.',
  })
  if (facts.depositLiability.byProperty.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No deposits held.' })
  } else {
    for (const property of facts.depositLiability.byProperty) {
      blocks.push({
        kind: 'mono',
        text: row(
          `${property.propertyName} (${property.depositCount} deposit${property.depositCount === 1 ? '' : 's'})`,
          property.liabilityCents,
        ),
      })
    }
    blocks.push({ kind: 'mono', text: row('HELD', facts.depositLiability.totalCents) })
  }

  // ==========================================================================
  // 1099-NEC. The reportable figure is NOT the total paid: a card payment is
  // reported by the processor on a 1099-K, so a vendor can sit under the
  // threshold despite the larger number. Both figures print, because the
  // difference between them is the one thing a filer must not have to guess at.
  // ==========================================================================
  blocks.push({ kind: 'subheading', text: '1099-NEC candidates' })
  blocks.push({
    kind: 'paragraph',
    text: 'The amount shown is what goes on the form. Card payments are excluded — those are reported by the processor on a 1099-K, not by the payer on a 1099-NEC. Vendors under the threshold are listed too.',
  })
  if (facts.vendors.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No vendors paid this year.' })
  } else {
    for (const vendor of facts.vendors) {
      blocks.push({ kind: 'mono', text: row(vendor.vendorName, vendor.reportableCents) })
      blocks.push({
        kind: 'mono',
        text: `  ${formatCents(vendor.totalPaidCents)} paid, ${formatCents(vendor.cardCents)} by card · ${
          vendor.requiresForm ? '1099-NEC required' : 'under the threshold'
        }${vendor.missingW9 ? ' · NO W-9 ON FILE' : ''}`,
      })
    }
    const missing = facts.vendors.filter((vendor) => vendor.missingW9).length
    if (missing > 0) {
      blocks.push({
        kind: 'paragraph',
        text: `${missing} vendor${missing === 1 ? '' : 's'} above are over the threshold with no W-9 on file.`,
      })
    }
  }

  // LAST, and in the same document. R-078's rule: a packet that dropped what
  // it could not classify is a packet somebody files.
  blocks.push({
    kind: 'subheading',
    text: `Unmapped — ${facts.exceptions.length} ${facts.exceptions.length === 1 ? 'row' : 'rows'}, ${formatCents(facts.exceptionCents)}`,
  })
  if (facts.exceptions.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'Every row mapped. Nothing was dropped.' })
  } else {
    for (const line of facts.exceptions) {
      blocks.push({
        kind: 'mono',
        text: row(`${line.propertyName} · ${line.description}`, line.amountCents),
      })
      if (line.reason) blocks.push({ kind: 'mono', text: `  ${line.reason}` })
    }
  }

  blocks.push({ kind: 'subheading', text: 'Exhibits' })
  blocks.push(
    ...exhibitIndexBlocks(
      facts.exhibits,
      'No Form 1098 was recorded for this entity and year, so nothing is attached.',
    ),
  )
  // What the bundle deliberately does NOT carry, so its absence is a decision
  // on the page rather than an omission the reader has to notice.
  blocks.push({
    kind: 'paragraph',
    text: 'Only evidence for figures this product did not itself compute is attached. Every other schedule above is derived from records this system holds and can reproduce; invoices, leases and receipts behind them are available from the property file on request.',
  })
  blocks.push({
    kind: 'paragraph',
    text: 'Mileage is not in this packet at all: nothing in this product captures trips, so Schedule E line 6 has no source.',
  })

  blocks.push({
    kind: 'footer',
    text: `Produced ${facts.generatedAt} (${facts.timezone}) by ${facts.generatedBy}`,
  })
  blocks.push({ kind: 'footer', text: TAX_PACKET_DISCLAIMER })

  return blocks
}

function row(label: string, cents: number): string {
  return padColumns(
    [label, formatCents(cents)],
    [{ width: COLUMN_LABEL }, { width: COLUMN_AMOUNT, align: 'right' }],
  )
}
