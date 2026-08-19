import { describe, expect, it } from 'vitest'
import { extractCapturedAt, extractGeotag } from './exif.ts'

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

/// A raw ASCII TIFF entry value, when the string is short enough to fit
/// inline in the 4-byte value field (count <= 4 for a 1-byte-per-char
/// type) - stored as the literal bytes, not a numeric offset, which is why
/// this is a separate helper from `entry()` above.
function asciiEntry(tag: number, str: string): Buffer {
  const bytes = Buffer.alloc(4)
  Buffer.from(str, 'ascii').copy(bytes)
  return Buffer.concat([u16(tag), u16(2), u32(str.length), bytes])
}

/// A JPEG carrying one APP1/EXIF segment whose GPS IFD holds a real
/// latitude/longitude - Pittsburgh, in degrees/minutes/seconds, the classic
/// GPS EXIF example (40°26'46"N, 79°58'56"W).
function jpegWithGps(): Buffer {
  const ifd0Offset = 8
  const gpsIfdOffset = ifd0Offset + 2 + 12 + 4 // count + one entry + next-ifd pointer
  const ifd0 = Buffer.concat([
    u16(1),
    entry(0x8825, 4, 1, gpsIfdOffset), // GPSInfoIFDPointer, LONG
    u32(0),
  ])

  const latRationalsOffset = gpsIfdOffset + 2 + 4 * 12 + 4 // count + 4 entries + next-ifd pointer
  const lonRationalsOffset = latRationalsOffset + 24
  const gpsIfd = Buffer.concat([
    u16(4),
    asciiEntry(0x0001, 'N\0'), // GPSLatitudeRef
    entry(0x0002, 5, 3, latRationalsOffset), // GPSLatitude, RATIONAL x3
    asciiEntry(0x0003, 'W\0'), // GPSLongitudeRef
    entry(0x0004, 5, 3, lonRationalsOffset), // GPSLongitude, RATIONAL x3
    u32(0),
  ])
  const latRationals = Buffer.concat([u32(40), u32(1), u32(26), u32(1), u32(46), u32(1)])
  const lonRationals = Buffer.concat([u32(79), u32(1), u32(58), u32(1), u32(56), u32(1)])

  const tiff = Buffer.concat([
    Buffer.from('MM', 'ascii'),
    u16(0x2a),
    u32(ifd0Offset),
    ifd0,
    gpsIfd,
    latRationals,
    lonRationals,
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    u16(payload.length + 2),
    payload,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])])
}

describe('extractGeotag', () => {
  it('reads a real GPS block and converts degrees/minutes/seconds to decimal', async () => {
    const geotag = await extractGeotag(jpegWithGps(), 'image/jpeg')
    expect(geotag).not.toBeNull()
    // 40 + 26/60 + 46/3600
    expect(geotag?.latitude).toBeCloseTo(40.446111, 5)
    // South/West refs are negative - 79 + 58/60 + 56/3600, negated for W.
    expect(geotag?.longitude).toBeCloseTo(-79.982222, 5)
  })

  it('returns null for a non-image content type', async () => {
    expect(await extractGeotag(jpegWithGps(), 'application/pdf')).toBeNull()
  })

  it('returns null rather than throwing on something that is not an image', async () => {
    expect(await extractGeotag(Buffer.from('not a photo'), 'image/jpeg')).toBeNull()
  })

  it('returns null for a JPEG with no GPS block at all', async () => {
    // A screenshot, a scan, or a phone with location services off - never
    // guessed from anywhere else, the same "undated beats wrongly dated"
    // posture extractCapturedAt already takes.
    const bare = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    expect(await extractGeotag(bare, 'image/jpeg')).toBeNull()
  })
})

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
