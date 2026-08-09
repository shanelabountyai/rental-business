import { describe, expect, it } from 'vitest'
import { extractCapturedAt } from './exif.ts'

// EXIF extraction against the REAL library (PROP-08, D-14).
//
// This file used to mock `exifr` entirely, which meant it proved the wrapper's
// branching and nothing about whether a photo's timestamp actually came out.
// That gap mattered the moment R-032's tidy-up switched to exifr's `lite`
// build to stop it probing for `fs` and `zlib` at import: lite rejects the
// bare `['DateTimeOriginal']` pick-array the full build accepts, and a mocked
// test would have sailed straight past it.
//
// The fixtures are built here rather than committed as binaries - a JPEG is
// four bytes of framing around a TIFF block, and a reviewer can check the
// bytes against the spec instead of trusting an opaque file.

const CAPTURED = '2026:03:14 09:26:53\0'

function u16(value: number) {
  return Buffer.from([value >> 8, value & 0xff])
}
function u32(value: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
/// A 12-byte TIFF directory entry: tag, type, count, value-or-offset.
function entry(tag: number, type: number, count: number, value: number) {
  return Buffer.concat([u16(tag), u16(type), u32(count), u32(value)])
}

/// A JPEG carrying one APP1/EXIF segment whose ExifIFD holds DateTimeOriginal.
function jpegWithCaptureTime(): Buffer {
  const date = Buffer.from(CAPTURED, 'ascii')
  const ifd0Offset = 8
  // IFD0: one entry (ExifIFDPointer, 0x8769, LONG) plus the next-IFD pointer.
  const exifIfdOffset = ifd0Offset + 2 + 12 + 4
  const ifd0 = Buffer.concat([
    u16(1),
    entry(0x8769, 4, 1, exifIfdOffset),
    u32(0),
  ])
  // ExifIFD: one entry (DateTimeOriginal, 0x9003, ASCII), string stored after.
  const dateOffset = exifIfdOffset + 2 + 12 + 4
  const exifIfd = Buffer.concat([
    u16(1),
    entry(0x9003, 2, date.length, dateOffset),
    u32(0),
  ])
  // "MM" = big-endian, 0x2a = the TIFF magic.
  const tiff = Buffer.concat([
    Buffer.from('MM', 'ascii'),
    u16(0x2a),
    u32(ifd0Offset),
    ifd0,
    exifIfd,
    date,
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    u16(payload.length + 2),
    payload,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])])
}

describe('extractCapturedAt', () => {
  it('reads DateTimeOriginal out of a real EXIF block', async () => {
    // The assertion the mocked version could not make. 09:26:53 local in the
    // EXIF block; EXIF carries no timezone, so the library reads it as local
    // time - which is why the comparison is on the wall-clock fields rather
    // than an absolute instant.
    const captured = await extractCapturedAt(jpegWithCaptureTime(), 'image/jpeg')
    expect(captured).toBeInstanceOf(Date)
    expect(captured?.getFullYear()).toBe(2026)
    expect(captured?.getMonth()).toBe(2) // March
    expect(captured?.getDate()).toBe(14)
    expect(captured?.getHours()).toBe(9)
    expect(captured?.getMinutes()).toBe(26)
  })

  it('returns null for a non-image content type', async () => {
    expect(await extractCapturedAt(jpegWithCaptureTime(), 'application/pdf')).toBeNull()
  })

  it('returns null rather than throwing on something that is not an image', async () => {
    // exifr throws "Unknown file format" here. A corrupt or unrecognised file
    // must not fail the upload - the photo is still evidence, just undated.
    expect(await extractCapturedAt(Buffer.from('not a photo'), 'image/jpeg')).toBeNull()
  })

  it('returns null for a JPEG with no EXIF block at all', async () => {
    // A screenshot or a scan. Falling back to the upload time would
    // misrepresent when the photo was taken, which is the one thing
    // `capturedAt` exists to get right.
    const bare = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    expect(await extractCapturedAt(bare, 'image/jpeg')).toBeNull()
  })
})
