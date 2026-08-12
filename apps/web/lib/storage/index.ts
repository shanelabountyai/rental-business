import 'server-only'

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { StorageAdapter } from './adapter.ts'
import { VercelBlobStorageAdapter } from './blob-adapter.ts'
import { LocalDiskStorageAdapter } from './local-adapter.ts'

export type { StorageAdapter } from './adapter.ts'

// D-14's one assignment, and the only place that chooses an implementation
// (R-100).
//
// SELECTED BY THE TOKEN, NOT BY NODE_ENV. `BLOB_READ_WRITE_TOKEN` is injected
// by Vercel wherever a Blob store is attached and is absent everywhere else,
// so the choice is made by what the environment actually has rather than by a
// label it claims. A `NODE_ENV === 'production'` check would put a laptop
// running a production build onto the real store, and — worse — would leave a
// deployed environment silently on local disk if the store were ever
// detached, which is the exact failure this item exists to end.
//
// Local disk stays the dev and test implementation deliberately. The suite
// must not depend on a network round trip or on somebody's Blob quota to
// assert that an upload worked, and D-14 chose disk for that reason rather
// than as a placeholder.
//
// Nothing needed migrating. The production database was empty when this
// landed, so there are no `Document` rows pointing at bytes on a vanished
// filesystem; the documents written during development live on the dev
// machine's disk and stay there, with the dev environment still reading them.
// That is luck of timing, not design — a week later this would have needed a
// backfill and there would have been nothing to back-fill *from*.
const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim()

export const storage: StorageAdapter = blobToken
  ? new VercelBlobStorageAdapter(blobToken)
  : new LocalDiskStorageAdapter(
      process.env.DOCUMENT_STORAGE_PATH ?? join(process.cwd(), '.data', 'documents'),
    )

/// True when durable storage is actually wired. Read by the deployment
/// check, not by the upload path: an upload must not behave differently
/// depending on where it lands.
export const storageIsDurable = Boolean(blobToken)

/// Never the caller-supplied file name alone - two uploads named `photo.jpg`
/// must not collide, and a name containing a path separator must not escape
/// the property's own folder.
export function generateStorageKey(propertyId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
  return `${propertyId}/${randomUUID()}-${safeName}`
}
