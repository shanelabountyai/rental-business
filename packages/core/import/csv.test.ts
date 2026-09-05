import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.ts'

describe('parseCsv', () => {
  it('parses a plain header and rows', () => {
    expect(parseCsv('a,b,c\r\n1,2,3\r\n4,5,6')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ])
  })

  it('accepts bare LF line endings, not just CRLF', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('unwraps a quoted field containing a comma', () => {
    expect(parseCsv('name,address\n"Smith, John","123 Elm St"')).toEqual([
      ['name', 'address'],
      ['Smith, John', '123 Elm St'],
    ])
  })

  it('unwraps a quoted field containing an embedded newline', () => {
    expect(parseCsv('notes\n"line one\nline two"\n')).toEqual([['notes'], ['line one\nline two']])
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('quote\n"She said ""hi""."')).toEqual([['quote'], ['She said "hi".']])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('drops a trailing blank line', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('preserves a genuinely blank cell', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ])
  })
})
