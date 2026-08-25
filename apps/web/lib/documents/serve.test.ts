import { describe, expect, it } from 'vitest'
import { documentResponse } from './serve.ts'

// The response every document byte in this product leaves through.
//
// The assertion that matters is the FIRST one: an uploader-declared
// `image/svg+xml` must never come back as something a browser will run in
// this app's origin. Everything else here guards the ways that could be
// undone by accident - a type with a parameter, a mixed-case header, a
// sniffable mislabel.

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function headersOf(contentType: string, fileName = 'f.bin') {
  const response = documentResponse(BYTES, { contentType, fileName })
  return {
    type: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    nosniff: response.headers.get('x-content-type-options'),
    length: response.headers.get('content-length'),
  }
}

describe('what may render in our own origin', () => {
  // THE POINT OF THE FILE. An applicant holding an apply/[token] link can
  // put these bytes and this declared type into Document; a letting agent
  // opens it with their session cookie attached.
  it('refuses to render an SVG, whatever it was declared as', () => {
    const headers = headersOf('image/svg+xml', 'payslip.svg')
    expect(headers.type).toBe('application/octet-stream')
    expect(headers.disposition).toMatch(/^attachment;/)
  })

  it('refuses to render HTML', () => {
    expect(headersOf('text/html', 'notes.html').type).toBe('application/octet-stream')
  })

  it('refuses anything it has not been told is safe', () => {
    // The list is an allowlist rather than a blocklist precisely so that a
    // type nobody thought of lands here rather than in the browser.
    expect(headersOf('application/xhtml+xml').type).toBe('application/octet-stream')
    expect(headersOf('image/svg+xml; charset=utf-8').type).toBe('application/octet-stream')
  })

  it('still renders the formats the product is made of', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      const headers = headersOf(type, 'lease.pdf')
      expect(headers.type, type).toBe(type)
      expect(headers.disposition, type).toMatch(/^inline;/)
    }
  })

  it('renders plain text, which is safe only because nosniff is unconditional', () => {
    // A .txt proof-of-insurance is a real upload on the property page, and
    // downloading it as an opaque blob would be a regression. It is safe
    // because `nosniff` stops a browser sniffing a text/plain body that is
    // really markup - the two are a pair, which is why they are asserted
    // together here.
    const headers = headersOf('text/plain', 'coi.txt')
    expect(headers.type).toBe('text/plain')
    expect(headers.disposition).toMatch(/^inline;/)
    expect(headers.nosniff).toBe('nosniff')
  })

  it('compares the bare type, not the raw header', () => {
    // A browser may send `image/jpeg; charset=binary`, and casing is not
    // guaranteed either. Neither may cost a tenant their photo preview.
    expect(headersOf('IMAGE/JPEG').type).toBe('image/jpeg')
    expect(headersOf(' image/jpeg; charset=binary ').type).toBe('image/jpeg')
  })

  it('always sets nosniff, including on the renderable path', () => {
    // Without it a mislabelled `image/png` that is really HTML can still be
    // sniffed and run, which hands back the hole the allowlist closes.
    expect(headersOf('image/png').nosniff).toBe('nosniff')
    expect(headersOf('image/svg+xml').nosniff).toBe('nosniff')
  })
})

describe('the filename in the header', () => {
  it('drops quotes and control characters', () => {
    // `Document.fileName` is `file.name` off the uploader's machine. A quote
    // ends the parameter early; a newline is a header Node refuses to send,
    // so it would be a 500 on somebody opening a lease.
    const headers = headersOf('application/pdf', 'a"b\r\nX-Evil: 1.pdf')
    expect(headers.disposition).toBe('inline; filename="abX-Evil: 1.pdf"')
  })

  it('falls back rather than emitting an empty filename', () => {
    expect(headersOf('application/pdf', '"""').disposition).toBe('inline; filename="document"')
  })
})

describe('content length', () => {
  it('comes from the bytes, never from a recorded size', () => {
    expect(headersOf('application/pdf').length).toBe(String(BYTES.byteLength))
  })
})
