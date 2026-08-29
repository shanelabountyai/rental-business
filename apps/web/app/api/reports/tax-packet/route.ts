import { csvCents, toCsv } from '@rental/core/ledger'
import { isAccountingBasis } from '@rental/core/tax'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { taxPacket } from '@/lib/tax/packet.ts'
import { exportableEntities } from '@/lib/tax/queries.ts'

// RPT-07 (R-081b): the packet as one file.
//
// ONE CSV WITH A `Schedule` COLUMN, not five downloads. A preparer who
// receives four of five files has no way to know a fifth existed, and the
// same reasoning put R-078's exception rows in the same file as its totals.

const HEADERS = [
  'Schedule',
  'Property',
  'Line',
  'Label',
  'Detail',
  'Amount',
  'Note',
] as const

export async function GET(request: Request) {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)

  const params = new URL(request.url).searchParams
  const entities = exportableEntities(scope)
  const entityId = params.get('entity') ?? entities[0]?.id
  const year = Number(params.get('year')) || new Date().getUTCFullYear() - 1
  const basisParam = params.get('basis') ?? 'cash'
  const basis = isAccountingBasis(basisParam) ? basisParam : 'cash'

  // Null for an entity outside the actor's own scope: 404, never 403, so
  // "forbidden" cannot be used to confirm the entity exists (ROLE-01).
  const packet = entityId ? await taxPacket(scope, entityId, year, basis) : null
  if (!packet) return new Response('Not found', { status: 404 })

  const rows: (string | number)[][] = []

  for (const property of packet.scheduleE) {
    for (const total of property.totals) {
      rows.push([
        'SCHEDULE_E',
        property.propertyName,
        total.line,
        total.label,
        '',
        csvCents(total.amountCents),
        '',
      ])
    }
    rows.push([
      'SCHEDULE_E',
      property.propertyName,
      '',
      'Net',
      '',
      csvCents(property.netCents),
      '',
    ])
  }

  for (const row of packet.capex) {
    rows.push([
      'CAPEX',
      row.propertyName,
      '',
      'Capital improvement',
      row.description,
      csvCents(row.amountCents),
      // ISO deliberately, and this is the exception to D-153. A CSV is read
      // by a spreadsheet and an accountant's software, both of which sort and
      // parse `YYYY-MM-DD` and neither of which parses `3 Aug 2026`.
      `In service ${row.bookedOn ?? 'unknown'}`,
    ])
  }

  for (const row of packet.depositLiability.byProperty) {
    rows.push([
      'DEPOSIT_LIABILITY',
      row.propertyName,
      '',
      'Held at 31 December',
      `${row.depositCount} deposit${row.depositCount === 1 ? '' : 's'}`,
      csvCents(row.liabilityCents),
      '',
    ])
  }

  for (const vendor of packet.vendors) {
    rows.push([
      'FORM_1099_NEC',
      '',
      '',
      vendor.vendorName,
      // The reportable figure is the one on the form; the total and the card
      // share are carried alongside so the difference is never a mystery.
      `paid ${csvCents(vendor.totalPaidCents)}, by card ${csvCents(vendor.cardCents)}`,
      csvCents(vendor.reportableCents),
      [
        vendor.requiresForm ? '1099-NEC required' : 'under threshold',
        vendor.w9OnFile ? 'W-9 on file' : 'NO W-9',
      ].join(' · '),
    ])
  }

  // LAST, and in the same file. A packet that dropped what it could not
  // classify would be a packet somebody files.
  for (const row of packet.exceptions) {
    rows.push([
      'UNMAPPED',
      row.propertyName,
      '',
      row.scheduleELabel,
      row.description,
      csvCents(row.amountCents),
      row.reason ?? '',
    ])
  }

  const csv = toCsv([...HEADERS], rows)
  const slug = packet.legalEntityName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tax-packet-${slug}-${packet.year}-${packet.basis}.csv"`,
      // A stale packet handed to an accountant is worse than none.
      'cache-control': 'no-store',
    },
  })
}
