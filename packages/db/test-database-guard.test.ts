import { describe, expect, it } from 'vitest'
import { remoteTestDatabaseError } from './test-database-guard.ts'

describe('remoteTestDatabaseError', () => {
  it('allows localhost, 127.0.0.1 and an unset URL', () => {
    expect(remoteTestDatabaseError('postgresql://u:p@localhost:5432/rental_test')).toBeNull()
    expect(remoteTestDatabaseError('postgresql://u:p@127.0.0.1:5432/rental_test')).toBeNull()
    expect(remoteTestDatabaseError(undefined)).toBeNull()
  })

  it('refuses a cloud host, naming it', () => {
    const msg = remoteTestDatabaseError('postgresql://u:p@ep-x-123.us-east-2.aws.neon.tech/neondb')
    expect(msg).toContain('ep-x-123.us-east-2.aws.neon.tech')
  })

  it('refuses a host that merely starts with localhost', () => {
    expect(remoteTestDatabaseError('postgresql://u:p@localhost.evil.example/db')).not.toBeNull()
  })

  it('refuses an unparseable URL rather than guessing', () => {
    expect(remoteTestDatabaseError('not a url')).not.toBeNull()
  })
})
