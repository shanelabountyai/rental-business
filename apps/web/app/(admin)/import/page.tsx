import { IMPORT_COLUMNS } from '@rental/core/import'
import { BulkDocumentForm } from '@/components/import/bulk-document-form.tsx'
import { ImportForm } from '@/components/import/import-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'

export const metadata = { title: 'Import — Rental Operations' }

/// One line per CSV column: which ones are always required, and when the
/// rest actually matter. Matches `packages/core/import/plan.ts`'s own
/// `ALWAYS_REQUIRED` list and its "required only when this row creates the
/// record" comment - kept here rather than generated from it, since the
/// wording a reader needs ("only if this property is new") is not something
/// worth deriving a data structure for.
const COLUMN_NOTES: Record<(typeof IMPORT_COLUMNS)[number], string> = {
  legal_entity_name: 'Required. Matched by exact name if it already exists.',
  legal_entity_type: 'Required only if this legal entity is new (LLC, PERSONAL, TRUST, CORPORATION, PARTNERSHIP).',
  legal_entity_formation_state: 'Optional, only used when the entity is new.',
  property_address_line1: 'Required. Matched against existing properties by address.',
  property_address_line2: 'Optional.',
  property_city: 'Required.',
  property_state: 'Required, two-letter code.',
  property_postal_code: 'Required.',
  property_name: 'Optional, only used when the property is new — defaults to the street address.',
  property_type: 'Required only if this property is new (SINGLE_FAMILY, DUPLEX, TRIPLEX, …).',
  property_timezone: 'Required only if this property is new — an IANA zone, e.g. America/Chicago.',
  property_history_starts_on: 'Optional, only used when the property is new. YYYY-MM-DD.',
  unit_name: 'Required.',
  unit_status: 'Optional, only used when the unit is new — defaults to OCCUPIED.',
  unit_market_rent_dollars: 'Optional, only used when the unit is new.',
  tenant_first_name: 'Required. Every row creates a new tenant — never matched against an existing one.',
  tenant_last_name: 'Required.',
  tenant_email: 'Optional.',
  tenant_phone: 'Optional.',
  lease_starts_on: 'Required, YYYY-MM-DD. Two rows sharing a unit and start date are one lease, two tenants.',
  lease_ends_on: 'Optional — blank means the tenancy is already month-to-month.',
  lease_rent_dollars: 'Required.',
  lease_rent_due_day: 'Optional, defaults to 1.',
  lease_deposit_dollars: 'Optional.',
  lease_deposit_arrangement: 'Optional — CASH, SURETY_BOND or NONE, defaults to CASH.',
  opening_balance_dollars:
    'Optional — what this tenancy still owed as of the date below, net of anything already paid. Give both this and the as-of date, or neither.',
  opening_balance_as_of: 'Required if an opening balance is given. YYYY-MM-DD, on or after the lease start date.',
}

export default async function ImportPage() {
  await requirePermission('property.write')

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-muted-foreground text-sm">
          Bring an existing portfolio&rsquo;s properties, tenants and leases in from
          a spreadsheet, plus the paperwork that goes with them. A tenancy
          that still owed money the moment it was migrated in can carry that
          as an opening balance — charged once the lease is activated, the
          same as everything else an inherited tenancy waits on staff review
          for.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Properties, tenants and leases</h2>
        <ImportForm />
        <details className="rounded-md border p-4 text-sm">
          <summary className="cursor-pointer font-medium">Column reference</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Column
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {IMPORT_COLUMNS.map((column) => (
                  <tr key={column} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{column}</td>
                    <td className="px-3 py-2">{COLUMN_NOTES[column]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Documents</h2>
        <p className="text-muted-foreground text-sm">
          Attaches to properties that already exist — this section never
          creates one. Import properties above first.
        </p>
        <BulkDocumentForm />
      </section>
    </div>
  )
}
