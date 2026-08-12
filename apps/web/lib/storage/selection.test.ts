import { afterEach, describe, expect, it, vi } from 'vitest'

// Which storage implementation gets wired, and why (D-14, R-100).
//
// The adapters themselves are covered elsewhere - local-adapter.test.ts
// round-trips real bytes, and the Blob adapter is three SDK calls that cannot
// be asserted without a network and somebody's quota. What is worth a test is
// the CHOICE, because getting it wrong is silent in both directions: a
// deployed environment on local disk loses every upload at the end of the
// request, and a laptop pointed at the real store writes test fixtures into
// production storage.
//
// `vi.resetModules()` per case because the selection happens once at module
// load - which is the point of it, and also why it cannot be tested by
// calling a function.

async function loadStorage(env: Record<string, string | undefined>) {
  vi.resetModules()
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await import('./index.ts')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(() => {
  vi.resetModules()
})

describe('choosing a storage implementation', () => {
  it('uses durable storage when a Blob token is present', async () => {
    const { storage, storageIsDurable } = await loadStorage({
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_TESTTOKEN_notreal',
    })
    expect(storageIsDurable).toBe(true)
    expect(storage.constructor.name).toBe('VercelBlobStorageAdapter')
  })

  it('falls back to local disk when there is no token', async () => {
    const { storage, storageIsDurable } = await loadStorage({
      BLOB_READ_WRITE_TOKEN: undefined,
    })
    expect(storageIsDurable).toBe(false)
    expect(storage.constructor.name).toBe('LocalDiskStorageAdapter')
  })

  it('does NOT decide on NODE_ENV', async () => {
    // The tempting version of this seam is `NODE_ENV === 'production'`. It is
    // wrong in both directions, and this is the assertion that keeps somebody
    // from reintroducing it: a production build on a laptop must not reach
    // the real store, and - the failure this item exists to end - a deployed
    // environment whose Blob store was detached must not quietly resume
    // writing to a filesystem that vanishes after the request.
    const { storageIsDurable } = await loadStorage({
      NODE_ENV: 'production',
      BLOB_READ_WRITE_TOKEN: undefined,
    })
    expect(storageIsDurable).toBe(false)
  })

  it('treats a blank token as absent rather than as a token', async () => {
    // An env var set to "" is what a half-configured deployment looks like,
    // and it must not select a store the SDK would then reject at upload time
    // with the file already accepted from the tenant.
    const { storageIsDurable } = await loadStorage({ BLOB_READ_WRITE_TOKEN: '   ' })
    expect(storageIsDurable).toBe(false)
  })
})
