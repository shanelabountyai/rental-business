// RFC 4180 CSV parsing for bulk data import (R-168, PRD §6.8).
//
// Hand-rolled, matching packages/core/ledger/csv.ts's own reasoning for
// writing rather than importing: the format is small and no installed
// dependency does it. That file only ever needed to WRITE a CSV; this one
// has to READ one a stranger produced in Excel or Sheets, so it has to cope
// with quoted fields, embedded commas/newlines inside quotes, doubled-quote
// escaping, a leading BOM (Excel on Windows writes one), and CRLF or bare LF
// line endings - all things a hand-typed row would never need.

/**
 * Splits raw CSV text into rows of raw field strings. The header row is
 * `rows[0]` like any other - callers that need it separated slice it off,
 * same as every other parser this shape.
 *
 * A run of fully-blank trailing rows (the newline Excel appends at the file's
 * end) is dropped, so callers never have to special-case a phantom last row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnyField = false

  const src = text.replace(/^﻿/, '')

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      sawAnyField = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
      sawAnyField = true
    } else if (ch === '\r') {
      // swallowed; the paired \n (or EOF, for an old Mac-style file) ends
      // the row below
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAnyField = false
    } else {
      field += ch
      sawAnyField = true
    }
  }
  // The file need not end with a newline - whatever is left is the last row.
  if (sawAnyField || field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  while (rows.length > 0 && isBlankRow(rows[rows.length - 1]!)) {
    rows.pop()
  }

  return rows
}

function isBlankRow(row: string[]): boolean {
  return row.every((field) => field.trim() === '')
}
