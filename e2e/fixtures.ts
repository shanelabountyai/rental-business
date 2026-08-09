// Shared fixture helpers for the end-to-end suite.

let counter = 0

/**
 * A phone number no other fixture in this run is holding.
 *
 * EVERY e2e fixture used to hard-code one, and each seed helper is called
 * once per test per browser project - so a single run left ten active
 * tenants sharing one number. That is exactly the ambiguity `decideRoute`
 * refuses to guess at (COMM-01, R-017): a number matching more than one
 * party routes nowhere, on purpose, because filing a conversation under the
 * wrong person's permanent record is a cross-tenant data leak.
 *
 * It had already cost something. A crashed run left an active tenant
 * holding `sms-intake.test.ts`'s hard-coded number, and every run afterwards
 * saw two candidates and correctly declined to route - eight tests failing
 * on the feature working against its own fixture, for an unknown number of
 * runs before anybody read the error properly.
 *
 * Sequential rather than random: a collision that happens one run in a
 * thousand is worse than one that happens every time, because nobody ever
 * finds it.
 */
export function uniquePhone(): string {
  counter += 1
  // +1512 555 + a 6-digit slot. The worker pid keeps parallel Playwright
  // workers - which are separate processes with their own counter - apart.
  const slot = (process.pid % 1000) * 1000 + (counter % 1000)
  return `+1512555${String(slot).padStart(6, '0')}`
}
