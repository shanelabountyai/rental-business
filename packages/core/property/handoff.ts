// The sale / acquisition handoff packet (DOC-06, RISK-09; R-092). Pure - no
// database, no Next.js. The app fetches; this decides what the file says.
//
// ==========================================================================
// AN EXPORT IS THE ONE PLACE WHERE EVERY ACCESS-CONTROL DECISION IN THIS
// PRODUCT GETS RE-ASKED AT ONCE, so what is NOT in here is as designed as
// what is. Three exclusions, each with its own reason:
//
//   * ACCESS CODES ARE INVENTORIED, NEVER PRINTED. R-005 made a vendor
//     seeing a lockbox code a privileged, individually audited read
//     (`accesscode.reveal`), and R-091 turned retiring them into a safety
//     act. A packet that printed every code would launder every one of those
//     reveals into a single line in a log, and put them in a file that gets
//     emailed. What a buyer needs at closing is to know which doors are
//     keyed how and how many codes exist; the codes themselves are handed
//     over in person, which is what actually happens anyway.
//   * NOTHING FROM A CONFIDENTIAL SAFETY CASE, and nothing that would betray
//     one (D-107). The lock-change work order R-091 raises IS in the vendor
//     history, because it is an ordinary re-key and hiding it would mean not
//     doing it - but `WorkOrder.restrictedPartyNote` is not, because that
//     column names a household member and exists only so a locksmith at the
//     door reads it. `handoff.test.ts` asserts the shape carries no such
//     field.
//   * NO MORTGAGE AND NO INSURANCE DECLARATIONS. Neither transfers with the
//     house: the seller's loan is paid off at closing and the seller's
//     policy is cancelled. Including them would put the seller's own
//     financing in the buyer's file for no purpose. Warranties and the HOA
//     documents DO transfer, and they are here.
// ==========================================================================

import type { DocumentBlock, PacketExhibit } from '../documents/index.ts'
import { exhibitIndexBlocks, padColumns, wrapMono } from '../documents/index.ts'
import { formatCents } from '../money/index.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

export interface HandoffUnit {
  name: string
  status: string
  bedrooms: number | null
  bathrooms: number | null
}

export interface HandoffLease {
  leaseId: string
  unitName: string
  /// Every tenant on the tenancy, primary first.
  tenantNames: readonly string[]
  status: string
  startsOn: BusinessDate
  endsOn: BusinessDate | null
  isMonthToMonth: boolean
  rentCents: number
  rentDueDay: number
  /// What is actually held, summed across deposit types. RISK-09's whole
  /// point: a deposit survives the sale and becomes the buyer's liability.
  depositHeldCents: number
  /// Positive means the tenant owes.
  balanceCents: number
  /// Set where notice has already been given - a buyer inheriting a tenancy
  /// that ends in three weeks is inheriting a vacancy, and a packet that did
  /// not say so would be the misrepresentation.
  noticeEffectiveOn: BusinessDate | null
}

/// The INVENTORY. No `code` field, deliberately, and there is no version of
/// this type that has one.
export interface HandoffAccessCode {
  unitName: string
  type: string
  label: string | null
  issuedOn: BusinessDate
}

/// One completed job. `scope` is the work description a dispatcher wrote; no
/// note field of any kind - see this file's header.
export interface HandoffVendorJob {
  completedOn: BusinessDate | null
  vendorName: string
  scope: string
  costCents: number
}

export interface HandoffWarranty {
  category: string
  provider: string
  coverageSummary: string | null
  expiresOn: BusinessDate | null
}

export interface HandoffFile {
  propertyName: string
  addressLine1: string
  addressLine2: string | null
  city: string
  state: string
  postalCode: string
  entityName: string
  propertyType: string
  yearBuilt: number | null
  units: readonly HandoffUnit[]
  leases: readonly HandoffLease[]
  accessCodes: readonly HandoffAccessCode[]
  vendorJobs: readonly HandoffVendorJob[]
  warranties: readonly HandoffWarranty[]
  /// Null where PROP-06's HOA record was never filled in at all, which is a
  /// different fact from an association that records no cap - see the block
  /// builder, which words all three.
  hoa: { association: string; hasRentalCap: boolean; rentalCapPolicy: string | null } | null
  exhibits: readonly PacketExhibit[]
  generatedAt: string
  generatedBy: string
  timezone: string
}

const WIDTH = 96

export function depositTotalCents(leases: readonly HandoffLease[]): number {
  return leases.reduce((sum, lease) => sum + lease.depositHeldCents, 0)
}

/// The blank a form has where a fact is not knowable yet. Its own constant so
/// the tests can find every one of them: a "template" with a plausible
/// invented buyer name in it is the failure mode this is guarding against.
export const BLANK = '______________________________'

/**
 * The tenant-notification-of-transfer draft, one per tenancy.
 *
 * A FORM WITH BLANKS, NOT A MERGE TEMPLATE, and the distinction is
 * load-bearing. R-062's document service fails loudly on a missing merge
 * field, which is right for a lease; here the buyer's name, the buyer's
 * address and the closing date are *unknowable at the moment the packet is
 * assembled* and inventing plausible values for them would produce a letter
 * that reads as finished. So the blanks are visible blanks.
 *
 * DRAFT ONLY. Which notice a state requires when a deposit changes hands, and
 * by when, is jurisdiction configuration this item did not build (D-4) - so
 * this says what was held and by whom, names the gap, and leaves the legal
 * form to the attorney review every artifact in this product requires.
 */
export function depositTransferDraft(input: {
  tenantNames: readonly string[]
  addressLine1: string
  unitName: string
  depositHeldCents: number
  sellerEntityName: string
}): string[] {
  return [
    `To: ${input.tenantNames.join(', ')}`,
    `Re: ${input.addressLine1} — ${input.unitName}`,
    `Date: ${BLANK}`,
    '',
    `Your tenancy at the address above continues unchanged. Ownership of the property transferred from ${input.sellerEntityName} to ${BLANK} on ${BLANK}.`,
    '',
    `Your security deposit of ${formatCents(input.depositHeldCents)} was transferred to the new owner, who now holds it and is responsible for returning it to you under your lease and applicable law. Your lease, its rent, its term and its terms are unaffected by the sale.`,
    '',
    `From ${BLANK}, pay rent and send all notices to:`,
    `    ${BLANK}`,
    `    ${BLANK}`,
    `    ${BLANK}`,
    '',
    `Questions before that date: ${BLANK}`,
  ]
}

/**
 * The estoppel certificate for one tenancy.
 *
 * WHAT IT ASSERTS IS WHAT THIS SYSTEM HOLDS, AND IT SAYS SO. An estoppel is
 * signed by the TENANT and is relied on by a buyer and their lender precisely
 * where it differs from the seller's own records - so a certificate that
 * presented our figures as agreed fact would defeat its own purpose. The
 * figures are stated as the landlord's record, on a date, and the tenant is
 * asked to confirm or correct them.
 *
 * NO SIGNATURE MACHINERY. R-063's ceremony binds a lease to a `LeaseEnvelope`
 * and applies consequences on completion; an estoppel has no consequence
 * inside this product at all - it is evidence handed to somebody outside it.
 * A wet signature block on a printed page is what a title company asks for
 * and is the smaller thing that works.
 */
export function estoppelCertificateBlocks(input: {
  lease: HandoffLease
  addressLine1: string
  city: string
  state: string
  postalCode: string
  entityName: string
  generatedAt: string
  generatedBy: string
  timezone: string
}): DocumentBlock[] {
  const { lease } = input
  const term = lease.isMonthToMonth
    ? 'Month-to-month'
    : `${lease.startsOn} to ${lease.endsOn ?? 'no end date recorded'}`

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'Tenant estoppel certificate' },
    { kind: 'meta', text: `Property: ${input.addressLine1}, ${input.city}, ${input.state} ${input.postalCode}` },
    { kind: 'meta', text: `Unit: ${lease.unitName}` },
    { kind: 'meta', text: `Landlord of record: ${input.entityName}` },
    { kind: 'meta', text: `Tenant(s): ${lease.tenantNames.join(', ')}` },
    { kind: 'meta', text: `Prepared: ${input.generatedAt} (${input.timezone}) by ${input.generatedBy}` },
    {
      kind: 'paragraph',
      text: 'The landlord has recorded the following about your tenancy. This certificate is being prepared because the property may change hands, and a buyer and their lender will rely on it. Read each line. If any of it is wrong, correct it below rather than signing over it — the whole purpose of this document is to catch anything the landlord’s records have got wrong.',
    },
    { kind: 'subheading', text: 'What the landlord’s records say' },
  ]

  const columns = [{ width: 34 }, { width: 40 }] as const
  const rows: [string, string][] = [
    ['Lease term', term],
    ['Rent', `${formatCents(lease.rentCents)} per month, due on day ${lease.rentDueDay}`],
    ['Security deposit held', formatCents(lease.depositHeldCents)],
    [
      'Balance on the account',
      lease.balanceCents === 0
        ? 'Nothing owed and nothing in credit'
        : lease.balanceCents > 0
          ? `${formatCents(lease.balanceCents)} owed by the tenant`
          : `${formatCents(-lease.balanceCents)} held in credit for the tenant`,
    ],
    [
      'Notice to end the tenancy',
      lease.noticeEffectiveOn
        ? `Given — the tenancy ends ${lease.noticeEffectiveOn}`
        : 'None on file',
    ],
  ]
  for (const [label, value] of rows) {
    blocks.push({ kind: 'mono', text: padColumns([label, value], columns) })
  }

  blocks.push(
    { kind: 'subheading', text: 'What the tenant confirms' },
    {
      kind: 'paragraph',
      text: 'By signing below I confirm that the lease described above is the whole of my agreement with the landlord, that it is in force, and that the figures above are correct — except as I have written under "Corrections". I am not aware of any unfulfilled promise by the landlord, and I have not prepaid rent beyond the amount shown.',
    },
    { kind: 'subheading', text: 'Corrections' },
  )
  for (let index = 0; index < 4; index += 1) {
    blocks.push({ kind: 'mono', text: BLANK.repeat(2) })
  }

  blocks.push(
    { kind: 'subheading', text: 'Signature' },
    ...lease.tenantNames.flatMap((name): DocumentBlock[] => [
      { kind: 'mono', text: padColumns(['Signature', 'Date'], [{ width: 46 }, { width: 24 }]) },
      { kind: 'mono', text: padColumns([BLANK, BLANK.slice(0, 20)], [{ width: 46 }, { width: 24 }]) },
      { kind: 'mono', text: name },
      { kind: 'mono', text: '' },
    ]),
    {
      kind: 'footer',
      text: 'Draft prepared by a property-management system from the landlord’s own records. It is not legal advice and has not been reviewed by an attorney. Nothing here changes the lease.',
    },
  )
  return blocks
}

/**
 * The handoff packet itself.
 *
 * ONE DOCUMENT, ordered the way somebody diligencing a purchase reads: what
 * the thing is, who is in it and on what terms, what money is held on their
 * behalf, what physically opens the doors, what has been done to it, and what
 * is warranted. The exhibit index is last, per D-50, and names what could not
 * be attached rather than quietly omitting it.
 */
export function handoffPacketBlocks(file: HandoffFile): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: `Property handoff packet — ${file.propertyName}` },
    {
      kind: 'meta',
      text: `Address: ${[file.addressLine1, file.addressLine2].filter(Boolean).join(', ')}, ${file.city}, ${file.state} ${file.postalCode}`,
    },
    { kind: 'meta', text: `Owner of record: ${file.entityName}` },
    {
      kind: 'meta',
      text: `Type: ${file.propertyType}${file.yearBuilt ? ` · built ${file.yearBuilt}` : ''}`,
    },
    { kind: 'meta', text: `Prepared: ${file.generatedAt} (${file.timezone}) by ${file.generatedBy}` },
    {
      kind: 'paragraph',
      text: 'This is the file for one property as the landlord’s records hold it on the date above. Every figure is a statement about that moment: rents get paid, balances move and tenancies end, so a packet is evidence of what was represented and when, not a live view.',
    },
  ]

  // Said up front rather than discovered as a gap at the bottom of page six.
  blocks.push({ kind: 'subheading', text: 'What is deliberately not in here' }, {
    kind: 'paragraph',
    text: 'Access codes are listed but their values are not printed — those are released individually, in person, and every release is logged. The seller’s mortgage and the seller’s own insurance policies are excluded because neither transfers with the house. Anything held under a restricted access control is excluded entirely and is not referred to.',
  })

  blocks.push({ kind: 'subheading', text: 'Units' })
  const unitColumns = [{ width: 22 }, { width: 16 }, { width: 20 }] as const
  blocks.push({
    kind: 'mono',
    text: padColumns(['Unit', 'Status', 'Beds / baths'], unitColumns),
  })
  for (const unit of file.units) {
    blocks.push({
      kind: 'mono',
      text: padColumns(
        [
          unit.name,
          unit.status,
          unit.bedrooms == null && unit.bathrooms == null
            ? 'Not recorded'
            : `${unit.bedrooms ?? '?'} / ${unit.bathrooms ?? '?'}`,
        ],
        unitColumns,
      ),
    })
  }

  blocks.push({ kind: 'subheading', text: 'Tenancies' })
  if (file.leases.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No tenancy is running at this property.' })
  }
  for (const lease of file.leases) {
    blocks.push(
      { kind: 'mono', text: `${lease.unitName} — ${lease.tenantNames.join(', ')}` },
      ...wrapMono(
        [
          `Term: ${lease.isMonthToMonth ? 'month-to-month' : `${lease.startsOn} to ${lease.endsOn ?? 'no end date recorded'}`}`,
          `Rent: ${formatCents(lease.rentCents)} on day ${lease.rentDueDay}`,
          `Deposit held: ${formatCents(lease.depositHeldCents)}`,
          `Account balance: ${lease.balanceCents === 0 ? 'nil' : lease.balanceCents > 0 ? `${formatCents(lease.balanceCents)} owed` : `${formatCents(-lease.balanceCents)} in credit`}`,
          lease.noticeEffectiveOn
            ? `NOTICE GIVEN — the tenancy ends ${lease.noticeEffectiveOn}`
            : 'No notice given',
        ].join(' · '),
        WIDTH,
        4,
      ).map((text) => ({ kind: 'mono' as const, text })),
      { kind: 'mono', text: '' },
    )
  }

  const held = depositTotalCents(file.leases)
  blocks.push(
    { kind: 'subheading', text: 'Deposits held' },
    {
      kind: 'paragraph',
      text: `${formatCents(held)} is held across ${file.leases.length} ${file.leases.length === 1 ? 'tenancy' : 'tenancies'}. A deposit survives the sale: it is the tenant’s money, it becomes the buyer’s liability at closing, and every tenant has to be told in writing that it moved. A draft of that notice, one per tenancy, is at the end of this packet.`,
    },
  )

  blocks.push({ kind: 'subheading', text: 'Keys and access codes' })
  if (file.accessCodes.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No access code is recorded for this property.' })
  } else {
    const codeColumns = [{ width: 20 }, { width: 20 }, { width: 30 }, { width: 14 }] as const
    blocks.push({
      kind: 'mono',
      text: padColumns(['Unit', 'Type', 'Label', 'On file since'], codeColumns),
    })
    for (const code of file.accessCodes) {
      blocks.push({
        kind: 'mono',
        text: padColumns(
          [code.unitName, code.type, code.label ?? '—', code.issuedOn],
          codeColumns,
        ),
      })
    }
    blocks.push({
      kind: 'paragraph',
      text: 'The codes themselves are not printed here. Each one is released individually and the release is logged; ask the seller to hand them over at closing, and change every one of them afterwards regardless.',
    })
  }

  blocks.push({ kind: 'subheading', text: 'Work done' })
  if (file.vendorJobs.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No completed work order is recorded for this property.' })
  } else {
    const jobColumns = [{ width: 12 }, { width: 26 }, { width: 40 }, { width: 12, align: 'right' as const }] as const
    blocks.push({
      kind: 'mono',
      text: padColumns(['Completed', 'Vendor', 'Work', 'Cost'], jobColumns),
    })
    for (const job of file.vendorJobs) {
      blocks.push({
        kind: 'mono',
        text: padColumns(
          [job.completedOn ?? '—', job.vendorName, job.scope, formatCents(job.costCents)],
          jobColumns,
        ),
      })
    }
  }

  blocks.push({ kind: 'subheading', text: 'Warranties' })
  if (file.warranties.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No warranty is recorded for this property.' })
  } else {
    for (const warranty of file.warranties) {
      blocks.push({
        kind: 'mono',
        text: `${warranty.category} — ${warranty.provider}${warranty.expiresOn ? ` · expires ${warranty.expiresOn}` : ' · no expiry recorded'}`,
      })
      if (warranty.coverageSummary) {
        blocks.push(
          ...wrapMono(warranty.coverageSummary, WIDTH, 4).map((text) => ({
            kind: 'mono' as const,
            text,
          })),
        )
      }
    }
  }

  // ALWAYS RENDERED, including when there is no record. The rental cap is the
  // one fact about an association that can make a buyer's whole plan illegal,
  // and the three answers - capped, not capped, never asked - are three
  // different things. Skipping the section on a null would silently deliver
  // the third as though it were the second.
  blocks.push({ kind: 'subheading', text: 'HOA' })
  if (!file.hoa) {
    blocks.push({
      kind: 'paragraph',
      text: 'No association record was ever filled in for this property. That is a gap in the seller’s file, not a statement that there is no association — establish it independently before closing.',
    })
  } else {
    blocks.push({ kind: 'mono', text: file.hoa.association })
    blocks.push({
      kind: 'paragraph',
      text: !file.hoa.hasRentalCap
        ? 'The seller’s record says this association imposes no rental cap. Verify it against the association’s own documents: a cap adopted after this was recorded would not show here.'
        : file.hoa.rentalCapPolicy
          ? `Rental cap: ${file.hoa.rentalCapPolicy}`
          : 'A rental cap is recorded for this association but its terms are not. Get the association’s documents before closing — a cap you cannot read is a cap you cannot plan around.',
    })
  }

  blocks.push({ kind: 'subheading', text: 'Tenant notices of transfer (drafts)' })
  if (file.leases.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No tenancy, so no notice to give.' })
  } else {
    blocks.push({
      kind: 'paragraph',
      text: 'One per tenancy, with the buyer’s details and the closing date left blank because neither is known here. What a given state requires when a deposit changes hands, and by when, is not configured in this system — have these reviewed before they are sent.',
    })
    for (const lease of file.leases) {
      for (const line of depositTransferDraft({
        tenantNames: lease.tenantNames,
        addressLine1: file.addressLine1,
        unitName: lease.unitName,
        depositHeldCents: lease.depositHeldCents,
        sellerEntityName: file.entityName,
      })) {
        blocks.push(
          ...(line === ''
            ? [{ kind: 'mono' as const, text: '' }]
            : wrapMono(line, WIDTH).map((text) => ({ kind: 'mono' as const, text }))),
        )
      }
      blocks.push({ kind: 'mono', text: '' }, { kind: 'mono', text: '—'.repeat(40) })
    }
  }

  blocks.push(
    { kind: 'subheading', text: 'Exhibits' },
    ...exhibitIndexBlocks(
      file.exhibits,
      'No estoppel certificate has been generated for this property. A buyer will ask for one per tenancy — generate them and produce this packet again.',
    ),
    {
      kind: 'footer',
      text: 'Assembled by a property-management system from its own records. It is not legal advice, it is not a survey, a title report or a condition report, and it has not been reviewed by an attorney.',
    },
  )

  return blocks
}
