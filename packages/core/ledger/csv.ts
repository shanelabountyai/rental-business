// CSV for the reports lenders and insurers ask for (RPT-02, R-044).
//
// Hand-rolled rather than a dependency: RFC 4180 escaping is four lines, and
// the part that actually matters here is the injection guard below, which no
// generic CSV writer does for you.

/**
 * One field, escaped.
 *
 * ==========================================================================
 * THE LEADING APOSTROPHE IS A SECURITY CONTROL, NOT A FORMATTING CHOICE.
 *
 * Excel, Numbers and Sheets all treat a cell beginning `=`, `+`, `-` or `@`
 * as a FORMULA. A tenant called `=cmd|'/c calc'!A1` — or, far more likely, a
 * property named `-Cedar Row` or a note somebody pasted — becomes executable
 * content in a spreadsheet opened by a lender who has no reason to distrust
 * the file we sent them. That is CSV injection, and the export in this item
 * is precisely the sort that leaves the building.
 *
 * Prefixing with an apostrophe makes the cell a literal string in every one
 * of those applications. It is visible in the raw file and invisible in the
 * spreadsheet, which is the right trade for a report a human reads.
 *
 * The tab and carriage return are included because a leading whitespace
 * character does not stop the formula parse — it just hides the marker from
 * anyone eyeballing the file.
 * ==========================================================================
 */
/// A plain number, including a negative one. Exempt from the guard below.
const NUMERIC = /^-?\d+(\.\d+)?$/

function escapeField(value: string | number | null | undefined): string {
  if (value == null) return ''
  const raw = String(value)
  // A NEGATIVE NUMBER IS NOT A FORMULA, and this exemption is load-bearing.
  // `-25.50` is a credit balance, it starts with `-`, and guarding it would
  // import as TEXT — so the one column a lender most wants to sum silently
  // stops summing. Caught by a test that renders a credit balance through
  // both functions together, because neither is wrong on its own.
  const guarded = !NUMERIC.test(raw) && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/**
 * Rows to a CSV document.
 *
 * `\r\n` line endings per RFC 4180 — Excel on Windows is the single most
 * likely consumer of a rent roll, and it is the one that cares.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeField).join(','))
    .join('\r\n')
}

/**
 * Money for a spreadsheet: `1500.00`, not `$1,500.00`.
 *
 * A currency-formatted string imports as TEXT and cannot be summed, which
 * defeats the entire purpose of sending somebody a CSV. The dollar sign
 * belongs on the screen; the file gets a number.
 */
export function csvCents(cents: number): string {
  return (cents / 100).toFixed(2)
}
