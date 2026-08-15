import { BUCKET_LABELS, csvCents, toCsv } from '@rental/core/ledger'
import { requireScope } from '@/lib/auth/guard.ts'
import { rentRoll } from '@/lib/payments/rent-roll.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

// The rent roll as a file (PAY-06, RPT-02, R-044).
//
// "Exportable — lenders and insurers ask for it" is the requirement, and the
// audience is the reason for two decisions that look fussy:
//
//   MONEY IS WRITTEN AS A BARE NUMBER (`1500.00`), never `$1,500.00`. A
//   currency-formatted string imports as text and cannot be summed, which
//   defeats the point of sending a spreadsheet.
//
//   EVERY FIELD GOES THROUGH `toCsv`'s injection guard, because this file
//   leaves the building and is opened by somebody with no reason to distrust
//   it. See `escapeField`.
//
// A route handler rather than a server action: the response IS the file, and
// an action cannot set Content-Disposition.

export async function GET() {
  // Same permission as the screen. An export is a read of the same data, and
  // a report endpoint that is laxer than the page it mirrors is the classic
  // way scoping gets bypassed.
  const { actor } = await requireScope('ledger.read')
  const scope = await currentScope(actor)
  const roll = await rentRoll(scope)

  const csv = toCsv(
    [
      'Property',
      'Unit',
      'Tenant',
      'Rent',
      'Balance',
      'Days late',
      'Aging bucket',
      'Past grace',
      'Oldest unpaid due',
      'Autopay',
      'Deposit held',
      'Subsidy portion',
      'Last contacted',
    ],
    roll.rows.map((row) => [
      row.propertyName,
      row.unitName,
      row.tenantName,
      csvCents(row.rentCents),
      csvCents(row.balanceCents),
      row.daysLate,
      BUCKET_LABELS[row.bucket],
      // Spelled out rather than TRUE/FALSE, and "unknown" is its own answer:
      // a property in a state with no configured rule (D-4) is neither past
      // grace nor within it, and printing "no" would assert something the
      // product does not know.
      row.graceUnknown ? 'unknown — no rule configured' : row.pastGrace ? 'yes' : 'no',
      row.oldestDueOn,
      row.autopay ? 'yes' : 'no',
      csvCents(row.depositHeldCents),
      csvCents(row.subsidyCents),
      row.lastContactOn,
    ]),
  )

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="rent-roll-${stamp}.csv"`,
      // Never cached. A rent roll is a point-in-time financial statement, and
      // a stale one handed to a lender is worse than none.
      'cache-control': 'no-store',
    },
  })
}
