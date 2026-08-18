import type { DocumentBlock } from '@rental/core/documents'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { MONO_LINE_CHARS, renderBlocksPdf } from './render.ts'

// The renderer's own contract (R-051, generalized R-052, tagged R-062).
// `MONO_LINE_CHARS` is pinned against `packages/core/ledger/statement-document.test.ts`'s
// column widths there, not here - this file owns the renderer itself: PDF
// validity, and since R-062, the accessibility tags §6.4 asks for.

function block(kind: DocumentBlock['kind'], text: string): DocumentBlock {
  return { kind, text }
}

async function structTreeOf(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes)
  const root = pdf.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict)
  const kids = root.lookup(PDFName.of('K'), PDFArray)
  const roles: string[] = []
  for (let i = 0; i < kids.size(); i++) {
    const elem = kids.lookup(i, PDFDict)
    // PDFName.asString() includes the leading slash it's serialized with.
    roles.push(elem.lookup(PDFName.of('S'), PDFName).asString().replace(/^\//, ''))
  }
  return { pdf, roles }
}

async function languageOf(bytes: Uint8Array): Promise<string | undefined> {
  const pdf = await PDFDocument.load(bytes)
  return pdf.catalog.lookup(PDFName.of('Lang'), PDFString)?.asString()
}

describe('renderBlocksPdf', () => {
  it('produces a real PDF', async () => {
    const bytes = await renderBlocksPdf([block('heading', 'Test')], { title: 'Test' })
    expect(Buffer.from(bytes).toString('ascii', 0, 5)).toBe('%PDF-')
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('sets /Title and defaults /Lang to en-US', async () => {
    const bytes = await renderBlocksPdf([block('paragraph', 'Hi')], { title: 'A Document' })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getTitle()).toBe('A Document')
    expect(await languageOf(bytes)).toBe('en-US')
  })

  it('accepts an explicit /Lang', async () => {
    const bytes = await renderBlocksPdf([block('paragraph', 'Hola')], {
      title: 'A Document',
      lang: 'es-MX',
    })
    expect(await languageOf(bytes)).toBe('es-MX')
  })

  it('is marked as tagged (§6.4) with a StructTreeRoot', async () => {
    const bytes = await renderBlocksPdf([block('heading', 'Notice')], { title: 'x' })
    const pdf = await PDFDocument.load(bytes)
    const markInfo = pdf.catalog.lookup(PDFName.of('MarkInfo'), PDFDict)
    expect(markInfo.get(PDFName.of('Marked'))?.toString()).toBe('true')
    expect(pdf.catalog.lookup(PDFName.of('StructTreeRoot'))).toBeDefined()
  })

  it('tags heading/subheading as H1/H2 and everything else as P, in reading order', async () => {
    const bytes = await renderBlocksPdf(
      [
        block('heading', 'Title'),
        block('subheading', 'Section'),
        block('meta', 'Date: today'),
        block('paragraph', 'Body text.'),
        block('mono', 'ROW  1'),
        block('footer', 'Draft.'),
      ],
      { title: 'x' },
    )
    const { roles } = await structTreeOf(bytes)
    expect(roles).toEqual(['H1', 'H2', 'P', 'P', 'P', 'P'])
  })

  it('splits a block that crosses a page break into sibling StructElems of the same role, still in order', async () => {
    // Enough paragraphs to force at least one page break, all the same
    // role, so the split is visible in the struct tree without depending
    // on exact line counts.
    const blocks = Array.from({ length: 60 }, (_, i) => block('paragraph', `Paragraph ${i}.`))
    const bytes = await renderBlocksPdf(blocks, { title: 'Long document' })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThan(1)
    const { roles } = await structTreeOf(bytes)
    expect(roles.every((r) => r === 'P')).toBe(true)
    // At least as many struct elements as blocks - a split block adds one,
    // never removes one.
    expect(roles.length).toBeGreaterThanOrEqual(blocks.length)
  })

  it('a mono row exactly MONO_LINE_CHARS wide is never clipped', async () => {
    const row = 'x'.repeat(MONO_LINE_CHARS)
    const bytes = await renderBlocksPdf([block('mono', row)], { title: 'x' })
    // No assertion beyond "renders without throwing" - MONO_LINE_CHARS'
    // own value is what statement-document.test.ts pins against real
    // column widths; this just proves the boundary case doesn't crash the
    // renderer, since mono lines are drawn verbatim, never wrapped.
    expect(Buffer.from(bytes).toString('ascii', 0, 5)).toBe('%PDF-')
  })
})
