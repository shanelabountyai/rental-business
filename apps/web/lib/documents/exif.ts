import 'server-only'

// The LITE build, deliberately, not the default `exifr` entry point.
//
// The full build probes for Node's `fs` and `zlib` at import time and logs
// "Couldn't load fs" / "Couldn't load zlib" on every dev-server start under
// Turbopack, which is noise that reads like a fault and cost a debugging
// pass to rule out. It needs neither: `fs` is for exifr's own file readers,
// and this only ever hands it a Buffer somebody already uploaded; `zlib` is
// for compressed XMP in PNG, and the tag read here lives in the EXIF/TIFF
// segment. Lite carries the EXIF parser and nothing else.
//
// A deep path because exifr publishes no `exports` map - `main` is the full
// UMD build and there is no named entry for lite. Pinned here in one place
// so a version bump has one thing to re-check.
import exifr from 'exifr/dist/lite.esm.mjs'

/**
 * The photo's original capture time (PROP-08, D-14) - "a photo's timestamp
 * IS the evidence" (schema.prisma's own comment on `Document.capturedAt`).
 *
 * Returns null for anything that isn't a photo, or a photo with no EXIF
 * block (a screenshot, a scan) - `capturedAt` is nullable for exactly this
 * reason, and falling back to the upload time would silently misrepresent
 * when the photo was actually taken.
 */
export async function extractCapturedAt(
  buffer: Buffer,
  contentType: string,
): Promise<Date | null> {
  if (!contentType.startsWith('image/')) return null
  try {
    // `{ exif: { pick: [...] } }` rather than the bare `['DateTimeOriginal']`
    // pick-array the full build accepts: lite has no name-to-segment
    // dictionary, so the shorthand throws inside the library rather than
    // returning nothing. Asserted by exif.test.ts against a real EXIF file.
    const tags = await exifr.parse(buffer, { exif: { pick: ['DateTimeOriginal'] } })
    const date: unknown = tags?.DateTimeOriginal
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null
  } catch {
    // A corrupt or unsupported EXIF block is not a reason to reject the
    // upload - the photo itself is still evidence, just undated. `exifr`
    // throws "Unknown file format" for anything it cannot recognise, which
    // includes plenty of legitimate images.
    return null
  }
}

export interface Geotag {
  latitude: number
  longitude: number
}

/**
 * Where the photo was taken (R-068 phase 2: "photos (timestamped,
 * geotagged)"). Null is the ordinary case - most screenshots and scans
 * carry no GPS tag at all, and plenty of phones have location services off
 * - never guessed from the property's own address, which would misrepresent
 * an ungeotagged photo as geotagged.
 *
 * `exifr.gps()` is the SAME lite build's own high-level helper (this file's
 * own header explains why the lite build, not the full one) - it already
 * carries the GPS dictionary and needs no separate import.
 */
export async function extractGeotag(
  buffer: Buffer,
  contentType: string,
): Promise<Geotag | null> {
  if (!contentType.startsWith('image/')) return null
  try {
    const result = await exifr.gps(buffer)
    if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
      return null
    }
    return { latitude: result.latitude, longitude: result.longitude }
  } catch {
    return null
  }
}
