import { describe, expect, it } from 'vitest'

import { localPoolCap } from './index.js'

/**
 * The check for the cap that keeps the two test runners under the local
 * server's `max_connections`. See the long comment on `localPoolCap` for the
 * arithmetic; this file only asserts the branches, because a wrong branch here
 * is invisible until a sweep dies at test 766 with somebody else's stack trace.
 */
describe('localPoolCap', () => {
  it('caps a local database, which is the only one whose pool we own', () => {
    const capped = localPoolCap('postgresql://u:p@localhost:5432/rental_test')
    expect(capped).toContain('connection_limit=8')
    // The rest of the URL has to survive intact - a dropped credential or
    // database name would fail loudly, but a dropped query parameter would not.
    expect(capped).toContain('u:p@localhost:5432/rental_test')
  })

  it('caps 127.0.0.1 too, since that is the same server by another name', () => {
    expect(localPoolCap('postgresql://u:p@127.0.0.1:5432/rental_ci')).toContain(
      'connection_limit=8',
    )
  })

  it('leaves a remote database alone, pooler included', () => {
    const neon = 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require'
    expect(localPoolCap(neon)).toBe(neon)
  })

  it('does not overwrite a limit somebody set on purpose', () => {
    const explicit = 'postgresql://u:p@localhost:5432/db?connection_limit=30'
    expect(localPoolCap(explicit)).toBe(explicit)
  })

  it('preserves existing parameters rather than replacing the query string', () => {
    const capped = localPoolCap('postgresql://u:p@localhost:5432/db?schema=public')
    expect(capped).toContain('schema=public')
    expect(capped).toContain('connection_limit=8')
  })

  it('passes an unset or unparseable URL through for Prisma to report', () => {
    expect(localPoolCap(undefined)).toBeUndefined()
    expect(localPoolCap('not a url')).toBe('not a url')
  })
})
