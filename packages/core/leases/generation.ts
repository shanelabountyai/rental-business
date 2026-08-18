import { mergeFieldsUsed, renderTemplate } from '../comms/merge-fields.ts'
import type { DocumentBlock } from '../documents/blocks.ts'
import { padColumns } from '../documents/blocks.ts'
import { ADDENDUM_LABELS, type AddendumKey } from './addenda.ts'
import { UTILITIES, type Utility, type UtilityPayer } from './validate.ts'

// Generating a lease document (LEASE-06, DOC-02, R-063).
//
// REUSES comms/merge-fields.ts's TOKEN SYNTAX AND RENDER ENGINE VERBATIM -
// same call R-062's `documents/template.ts` already made, and the same
// reason: a template a PM authored gets one `{{token}}` engine across the
// whole product, not a second implementation per document family. Only the
// CATALOGUE is lease-specific, because a lease's merge fields (rent,
// deposit, term, every adult's name) are not a letter's.

export interface LeaseMergeField {
  key: string
  label: string
  example: string
}

/// Closed, same two rules every other catalogue in this product states: no
/// internal identifiers, nothing requiring a computation the template author
/// would have to get right. The utility responsibility matrix is
/// DELIBERATELY NOT a merge field - LEASE-06 asks for it as a "matrix",
/// which is tabular data no amount of prose formatting represents honestly;
/// `leaseDocumentBlocks` below appends it as its own structural section
/// instead, the same call R-052's ledger statement made for a table no
/// merge field could hold.
export const LEASE_MERGE_FIELDS: readonly LeaseMergeField[] = [
  { key: 'tenants.names', label: 'Tenant name(s)', example: 'Jordan Blake, Sam Rivera' },
  { key: 'guarantors.names', label: 'Guarantor name(s), or "None"', example: 'Pat Rivera' },
  { key: 'property.name', label: 'Property name', example: 'Cedar Row' },
  { key: 'property.address', label: 'Property street address', example: '18 Cedar Row' },
  { key: 'unit.name', label: 'Unit', example: 'Unit B' },
  { key: 'entity.name', label: 'Owning entity name', example: 'Cedar Row Rentals LLC' },
  { key: 'term.starts_on', label: 'Lease start date', example: '2026-09-01' },
  { key: 'term.ends_on', label: 'Lease end date, or "month-to-month"', example: '2027-08-31' },
  { key: 'rent.amount', label: 'Monthly rent', example: '$1,600.00' },
  { key: 'rent.due_day', label: 'Day of month rent is due', example: '1' },
  { key: 'deposit.amount', label: 'Security deposit', example: '$1,600.00' },
  { key: 'pet.terms', label: 'Pet terms', example: 'No pets are authorized under this lease.' },
  { key: 'today', label: "Today's date", example: '2026-08-18' },
  { key: 'staff.name', label: 'Staff member generating this', example: 'Sam Rivera' },
] as const

const LEASE_FIELD_KEYS: ReadonlySet<string> = new Set(LEASE_MERGE_FIELDS.map((f) => f.key))

export function unknownLeaseMergeFields(text: string): string[] {
  return mergeFieldsUsed(text).filter((key) => !LEASE_FIELD_KEYS.has(key))
}

export { renderTemplate }

// ---------------------------------------------------------------------------
// Signer ordering (LEASE-06: "signer order incl. guarantors")
// ---------------------------------------------------------------------------

export interface SignerPartyInput {
  id: string
  name: string
}

export interface OrderedSigner {
  order: number
  role: 'TENANT' | 'GUARANTOR'
  name: string
  tenantId?: string
  guarantorId?: string
}

/**
 * Tenants first (primary tenant leading, the rest in the order they were
 * added), then guarantors. Not alphabetical - a lease's signer order is
 * usually read as "whose name is on the tenancy first", and the primary
 * tenant is already the one every other single-recipient message in this
 * product addresses first (see `LeaseTenant.isPrimary`'s own comment).
 */
export function orderedSigners(input: {
  primaryTenant: SignerPartyInput | null
  otherTenants: readonly SignerPartyInput[]
  guarantors: readonly SignerPartyInput[]
}): OrderedSigner[] {
  const signers: OrderedSigner[] = []
  let order = 1
  if (input.primaryTenant) {
    signers.push({ order: order++, role: 'TENANT', name: input.primaryTenant.name, tenantId: input.primaryTenant.id })
  }
  for (const t of input.otherTenants) {
    signers.push({ order: order++, role: 'TENANT', name: t.name, tenantId: t.id })
  }
  for (const g of input.guarantors) {
    signers.push({ order: order++, role: 'GUARANTOR', name: g.name, guarantorId: g.id })
  }
  return signers
}

// ---------------------------------------------------------------------------
// Document content (R-063; the disclaimer restates NOTICE_DISCLAIMER's own
// posture for a document that is signed rather than served).
// ---------------------------------------------------------------------------

export const LEASE_DISCLAIMER =
  'This lease was generated from a template maintained by the property manager and has not been reviewed by an attorney for compliance in this jurisdiction. It is not legal advice.'

export interface LeaseAddendumContent {
  key: AddendumKey
  bodyText: string
}

export interface LeaseSignatureFact {
  order: number
  role: 'TENANT' | 'GUARANTOR'
  name: string
  signedAt: string | null
  signedName: string | null
}

export interface LeaseDocumentFacts {
  propertyName: string
  propertyAddress: string
  unitName: string
  startsOn: string
  endsOn: string | null
  rentAmount: string
  depositAmount: string
  generatedOn: string
  bodyText: string
  addenda: readonly LeaseAddendumContent[]
  utilities: Readonly<Partial<Record<Utility, UtilityPayer>>>
  utilityLabels: Readonly<Record<string, string>>
  signers: readonly LeaseSignatureFact[]
}

/**
 * The blocks a generated lease is made of, in order: title, term/rent/
 * deposit meta, the rendered base template, the utility matrix as its own
 * table (never a merge field - see LEASE_MERGE_FIELDS's own comment), each
 * applicable addendum as its own section, a signature block naming every
 * signer and - once signed - when and as whom, and the standing disclaimer.
 *
 * Used for BOTH the unsigned draft and the executed PDF; `signers` carries
 * blank `signedAt`/`signedName` for the draft and the real values once every
 * signer has completed.
 */
export function leaseDocumentBlocks(facts: LeaseDocumentFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [{ kind: 'heading', text: 'Residential Lease Agreement' }]

  blocks.push({ kind: 'meta', text: `Date prepared: ${facts.generatedOn}` })
  blocks.push({ kind: 'meta', text: `Property: ${facts.propertyName} — ${facts.unitName}` })
  blocks.push({ kind: 'meta', text: `Address: ${facts.propertyAddress}` })
  blocks.push({
    kind: 'meta',
    text: `Term: ${facts.startsOn} to ${facts.endsOn ?? 'month-to-month'}`,
  })
  blocks.push({ kind: 'meta', text: `Rent: ${facts.rentAmount}` })
  blocks.push({ kind: 'meta', text: `Security deposit: ${facts.depositAmount}` })

  for (const paragraph of facts.bodyText.split(/\n\s*\n/)) {
    const text = paragraph.trim()
    if (text) blocks.push({ kind: 'paragraph', text })
  }

  const utilityEntries = UTILITIES.map((utility) => [utility, facts.utilities[utility]] as const).filter(
    ([, payer]) => payer && payer !== 'NOT_APPLICABLE',
  )
  if (utilityEntries.length > 0) {
    blocks.push({ kind: 'subheading', text: 'Utility responsibility' })
    const columns = [{ width: 20 }, { width: 12 }] as const
    for (const [utility, payer] of utilityEntries) {
      blocks.push({
        kind: 'mono',
        text: padColumns(
          [facts.utilityLabels[utility] ?? utility, payer === 'TENANT' ? 'Tenant' : 'Landlord'],
          columns,
        ),
      })
    }
  }

  for (const addendum of facts.addenda) {
    blocks.push({ kind: 'subheading', text: ADDENDUM_LABELS[addendum.key] })
    for (const paragraph of addendum.bodyText.split(/\n\s*\n/)) {
      const text = paragraph.trim()
      if (text) blocks.push({ kind: 'paragraph', text })
    }
  }

  blocks.push({ kind: 'subheading', text: 'Signatures' })
  for (const signer of facts.signers) {
    const label = signer.role === 'TENANT' ? 'Tenant' : 'Guarantor'
    blocks.push({
      kind: 'meta',
      text: signer.signedAt
        ? `${label} ${signer.order}: ${signer.signedName ?? signer.name} — signed electronically ${signer.signedAt}`
        : `${label} ${signer.order}: ${signer.name} — not yet signed`,
    })
  }

  blocks.push({ kind: 'footer', text: LEASE_DISCLAIMER })

  return blocks
}
