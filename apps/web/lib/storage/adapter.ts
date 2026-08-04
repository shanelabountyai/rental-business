// The storage contract every Document row's `storageKey` is read and written
// through (DOC-01). Nothing outside apps/web/lib/storage imports fs directly
// to touch an uploaded file - one seam, one place to swap the implementation.
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}
