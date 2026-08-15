import { describe, expect, it } from 'vitest'
import { csvCents, toCsv } from './csv.ts'

describe('toCsv', () => {
  it('writes a header row and CRLF line endings', () => {
    expect(toCsv(['a', 'b'], [[1, 2]])).toBe('a,b\r\n1,2')
  })

  it('quotes fields containing a comma, a quote or a newline', () => {
    expect(toCsv(['x'], [['Reyes, Dana']])).toBe('x\r\n"Reyes, Dana"')
    expect(toCsv(['x'], [['He said "no"']])).toBe('x\r\n"He said ""no"""')
    expect(toCsv(['x'], [['line one\nline two']])).toBe('x\r\n"line one\nline two"')
  })

  it('writes an empty field for null and undefined', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,')
  })

  describe('CSV injection — the reason this is hand-rolled', () => {
    it('NEUTRALISES A FORMULA, because this file is opened by a lender', () => {
      // Excel, Numbers and Sheets all execute a cell starting with = + - or @.
      // The realistic vector is not a malicious tenant name; it is a property
      // called "-Cedar Row" or a pasted note.
      for (const dangerous of ['=1+1', '+1', '-Cedar Row', '@SUM(A1)']) {
        const out = toCsv(['x'], [[dangerous]])
        expect(out.split('\r\n')[1].replace(/^"|"$/g, '')).toBe(`'${dangerous}`)
      }
    })

    it('catches a formula hidden behind leading whitespace', () => {
      // A leading tab does not stop the formula parse — it only hides the
      // marker from anybody eyeballing the raw file.
      expect(toCsv(['x'], [['\t=1+1']])).toContain("'\t=1+1")
    })

    it('guards AND quotes when a formula also contains a comma', () => {
      expect(toCsv(['x'], [['=SUM(A1,B1)']])).toBe('x\r\n"\'=SUM(A1,B1)"')
    })

    it('DOES NOT GUARD A NEGATIVE NUMBER — a credit balance must stay summable', () => {
      // The two functions are each correct alone and wrong together: a credit
      // balance is negative, `-` is a formula marker, and guarding it makes
      // the one column a lender wants to sum import as text.
      expect(toCsv(['balance'], [[csvCents(-2_550)]])).toBe('balance\r\n-25.50')
      expect(toCsv(['n'], [[-42]])).toBe('n\r\n-42')
    })

    it('still guards something that merely looks numeric', () => {
      expect(toCsv(['x'], [['-1+1']])).toContain("'-1+1")
      expect(toCsv(['x'], [['-1-2-3']])).toContain("'-1-2-3")
    })

    it('leaves ordinary text alone', () => {
      expect(toCsv(['x'], [['Cedar Row']])).toBe('x\r\nCedar Row')
    })
  })
})

describe('csvCents', () => {
  it('writes a SUMMABLE number, not a currency string', () => {
    // "$1,500.00" imports as text and cannot be summed, which defeats the
    // entire point of sending somebody a CSV.
    expect(csvCents(150_000)).toBe('1500.00')
    expect(csvCents(0)).toBe('0.00')
    expect(csvCents(-2_550)).toBe('-25.50')
  })
})
