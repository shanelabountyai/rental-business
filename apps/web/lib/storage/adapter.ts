// The storage contract every Document row's `storageKey` is read and written
// through (DOC-01). Nothing outside apps/web/lib/storage imports fs directly
// to touch an uploaded file - one seam, one place to swap the implementation.
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

/**
 * The key resolved to nothing: the row says there are bytes and there are not.
 *
 * A DISTINCT TYPE BECAUSE "GONE" AND "BROKEN" ARE DIFFERENT ANSWERS. A route
 * serving bytes must answer 404 for a missing object and let a real storage
 * failure - a Blob outage, a permissions error - stay a 500, or the first
 * outage renders as "this listing has no photos" and gets CDN-cached that
 * way. Both adapters raise this for their own "no such object" branch so the
 * distinction survives D-14's swap.
 */
export class MissingStoredObjectError extends Error {
  constructor(key: string) {
    super(`No stored object for key: ${key}`)
    this.name = 'MissingStoredObjectError'
  }
}
