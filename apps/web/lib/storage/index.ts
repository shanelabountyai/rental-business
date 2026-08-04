import 'server-only'

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { StorageAdapter } from './adapter.ts'
import { LocalDiskStorageAdapter } from './local-adapter.ts'

export type { StorageAdapter } from './adapter.ts'

// Typed as the interface, not the concrete class - D-14's whole point is
// that swapping the implementation later touches this one assignment.
export const storage: StorageAdapter = new LocalDiskStorageAdapter(
  process.env.DOCUMENT_STORAGE_PATH ?? join(process.cwd(), '.data', 'documents'),
)

/// Never the caller-supplied file name alone - two uploads named `photo.jpg`
/// must not collide, and a name containing a path separator must not escape
/// the property's own folder.
export function generateStorageKey(propertyId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
  return `${propertyId}/${randomUUID()}-${safeName}`
}
