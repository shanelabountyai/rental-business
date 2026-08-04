import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StorageAdapter } from './adapter.ts'
import { LocalDiskStorageAdapter } from './local-adapter.ts'

let root: string
// Typed as the interface, not the concrete class - this exercises the public
// contract every real caller (and a future S3-backed adapter) is held to,
// contentType argument included, rather than one implementation's shortcut.
let adapter: StorageAdapter

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'doc-storage-'))
  adapter = new LocalDiskStorageAdapter(root)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalDiskStorageAdapter', () => {
  it('writes and reads back the same bytes', async () => {
    const data = Buffer.from('hello evidence')
    await adapter.put('a/b/c.txt', data, 'text/plain')
    expect((await adapter.get('a/b/c.txt')).toString()).toBe('hello evidence')
  })

  it('creates intermediate directories as needed', async () => {
    await adapter.put('deep/nested/path/file.bin', Buffer.from([1, 2, 3]), 'application/octet-stream')
    expect(await adapter.get('deep/nested/path/file.bin')).toEqual(Buffer.from([1, 2, 3]))
  })

  it('deletes a file', async () => {
    await adapter.put('to-delete.txt', Buffer.from('x'), 'text/plain')
    await adapter.delete('to-delete.txt')
    await expect(adapter.get('to-delete.txt')).rejects.toThrow()
  })

  it('does not throw deleting something that was never there', async () => {
    await expect(adapter.delete('never-existed.txt')).resolves.toBeUndefined()
  })

  it('refuses a key that tries to escape the storage root', async () => {
    await expect(
      adapter.put('../../etc/passwd', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(/outside the storage root/)
  })
})
