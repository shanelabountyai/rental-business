import { describe, expect, it, vi } from 'vitest'

vi.mock('exifr', () => ({
  default: { parse: vi.fn() },
}))

const { extractCapturedAt } = await import('./exif.ts')
const exifr = (await import('exifr')).default as unknown as {
  parse: ReturnType<typeof vi.fn>
}

describe('extractCapturedAt', () => {
  it('returns null for a non-image content type without reading the buffer', async () => {
    const result = await extractCapturedAt(Buffer.from('not a photo'), 'application/pdf')
    expect(result).toBeNull()
    expect(exifr.parse).not.toHaveBeenCalled()
  })

  it('returns the EXIF DateTimeOriginal when present', async () => {
    const captured = new Date('2025-06-01T14:30:00.000Z')
    exifr.parse.mockResolvedValueOnce({ DateTimeOriginal: captured })
    const result = await extractCapturedAt(Buffer.from([]), 'image/jpeg')
    expect(result).toEqual(captured)
  })

  it('returns null when the photo has no EXIF block', async () => {
    exifr.parse.mockResolvedValueOnce(undefined)
    const result = await extractCapturedAt(Buffer.from([]), 'image/jpeg')
    expect(result).toBeNull()
  })

  it('returns null rather than throwing on a corrupt EXIF block', async () => {
    exifr.parse.mockRejectedValueOnce(new Error('bad EXIF'))
    const result = await extractCapturedAt(Buffer.from([]), 'image/jpeg')
    expect(result).toBeNull()
  })
})
