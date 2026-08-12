import 'server-only'

import { del, get, put } from '@vercel/blob'
import type { StorageAdapter } from './adapter.ts'

/**
 * Vercel Blob storage — D-14's swap, taken when it became due (R-100).
 *
 * D-14 named the trigger for this in advance: *"a real object store is a
 * same-interface swap, not a rewrite, whenever this deploys somewhere the
 * filesystem isn't durable across instances."* Deploying to Vercel met it.
 * Serverless functions get a fresh, per-invocation filesystem, so every
 * uploaded lease, vendor invoice and maintenance photo written by
 * `LocalDiskStorageAdapter` was gone by the next request — while the
 * `Document` row claiming it exists survived. The evidence trail is the
 * product; an evidence trail that loses its photos is not one.
 *
 * PRIVATE, NOT PUBLIC, AND THAT IS THE WHOLE POINT. Vercel Blob's better-known
 * mode is `access: 'public'`, which mints a permanent unauthenticated URL
 * guarded only by an unguessable suffix. That is a capability URL, and it is
 * the wrong shape for what this product stores: signed leases, ID documents,
 * photographs of the inside of somebody's home. One leaked URL — a support
 * ticket, a browser history, a screenshot — and it is public for ever, with no
 * revocation and nothing in the audit log to say it was read.
 *
 * `access: 'private'` keeps every read authenticated against the store's own
 * token, so bytes can only be fetched by this server. The routes that serve
 * files (`api/documents/[id]/file`, the vendor document route) keep doing
 * exactly what they did: authorise the caller, then stream the bytes. Nothing
 * about who may see a document changes here — which is the property a storage
 * swap has to have.
 *
 * `addRandomSuffix: false` because the pathname must stay equal to the
 * `storageKey` already on the `Document` row. `generateStorageKey()` already
 * puts a UUID in it, so collisions are handled; letting the SDK rewrite the
 * name would orphan every existing row from its bytes.
 */
export class VercelBlobStorageAdapter implements StorageAdapter {
  private readonly token: string

  constructor(token: string) {
    this.token = token
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await put(key, data, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      // The key is unique by construction, so an overwrite means a retry of
      // the same upload rather than a collision. Refusing it would turn a
      // duplicate submit into a 500 on a tenant's photo.
      allowOverwrite: true,
      token: this.token,
    })
  }

  async get(key: string): Promise<Buffer> {
    const result = await get(key, { access: 'private', token: this.token })
    // Null is "no such blob". The local adapter throws ENOENT for the same
    // case and both callers already treat a throw as "the file is gone", so
    // this keeps one behaviour across the seam rather than two.
    if (!result?.stream) {
      throw new Error(`No stored object for key: ${key}`)
    }
    return Buffer.from(await new Response(result.stream).arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    await del(key, { token: this.token })
  }
}
