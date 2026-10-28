import { describe, expect, it } from 'vitest'
import { targetRefusal } from './create-platform-admin.mts'

// PRD 11 §2.6: the script writes only the database the operator typed, and
// never a test database.
describe('db:create-platform-admin target check', () => {
  const url = 'postgresql://u:p@ep-cool-1.neon.tech:5432/rental?sslmode=require'

  it('writes only the typed host and database', () => {
    expect(targetRefusal(url, 'ep-cool-1.neon.tech/rental')).toBeNull()
    expect(targetRefusal(url, undefined)).toMatch(/--target is required.*ep-cool-1\.neon\.tech\/rental/)
    expect(targetRefusal(url, 'localhost/rental')).toMatch(/DATABASE_URL names ep-cool-1/)
  })

  it('refuses the test databases even when typed', () => {
    expect(targetRefusal('postgresql://u@localhost:5432/rental_test', 'localhost/rental_test')).toMatch(/test database/)
    expect(targetRefusal('postgresql://u@localhost:5432/rental_ci', 'localhost/rental_ci')).toMatch(/test database/)
  })

  it('refuses an unset URL', () => {
    expect(targetRefusal('', 'localhost/rental')).toMatch(/unset/)
  })
})
