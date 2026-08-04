import 'server-only'

import exifr from 'exifr'

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
    const date: Date | undefined = await exifr.parse(buffer, ['DateTimeOriginal'])
      .then((tags) => tags?.DateTimeOriginal)
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null
  } catch {
    // A corrupt or unsupported EXIF block is not a reason to reject the
    // upload - the photo itself is still evidence, just undated.
    return null
  }
}
