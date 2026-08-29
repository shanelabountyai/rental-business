// Explicit .js extension, not the bare './generated/client' directory: Next.js
// and Vite's bundler resolution paper over a directory import, but plain Node
// running a .mts script directly does not, and fails with
// ERR_UNSUPPORTED_DIR_IMPORT. The extension is correct everywhere either way -
// it is the file Prisma actually emits.
import { PrismaClient } from './generated/client/index.js'

/**
 * CAP THE POOL WHEN THE DATABASE IS LOCAL, because the test suites run many
 * processes against ONE Postgres and Prisma's default sizes each pool as if it
 * were the only client on the machine.
 *
 * Prisma's default `connection_limit` is `physical_cpus * 2 + 1`. Measured on
 * this laptop (10 cores): 21 backends from a single client. Nothing shares
 * them - one PrismaClient per PROCESS, and both runners are process-parallel:
 *
 *   e2e      5 Playwright workers + the `next start` server under test
 *            = 6 processes * 21 = 126
 *   vitest   forks pool, up to 9 forks
 *            = 9 * 21 = 189
 *
 * against a `max_connections` of 100, three of which Postgres reserves for
 * superusers. So the ceiling is exceeded by arithmetic, not by chance - the
 * pools just open lazily, which is why it presents as intermittency. The
 * symptom is `FATAL: sorry, too many clients already` raised from whichever
 * fixture happened to be seeding at peak, and it reads as a broken test rather
 * than an exhausted server: five unit tests in three files after R-129's
 * sweep, and three e2e tests in `maintenance.spec.ts` at test 766 of 1,054.
 *
 * 8 leaves headroom in both shapes (48 and 72). Deliberately not per-runner:
 * the worker count is not knowable from here, and a single number that fits
 * the worse of the two is the whole fix.
 *
 * ponytail: fixed 8, sized against a 100-connection server. If max_connections
 * or the worker count moves, this number moves with it - or derive it from
 * TEST_PARALLEL_INDEX / VITEST_POOL_ID if that ever stops being true.
 *
 * NOT applied to a remote database. Neon is reached through its own pooler,
 * which is sized on the other side of the connection and is none of our
 * business. CI's postgres:17 service IS localhost, and gets the cap too -
 * which is the point: local and CI should fail and pass for the same reasons.
 */
export function localPoolCap(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const parsed = new URL(url)
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (!isLocal || parsed.searchParams.has('connection_limit')) return url
    parsed.searchParams.set('connection_limit', '8')
    return parsed.toString()
  } catch {
    // An unparseable URL is Prisma's problem to report, not ours to swallow.
    return url
  }
}

// Reused across hot reloads in dev so Next.js doesn't open a new pool per edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasourceUrl: localPoolCap(process.env.DATABASE_URL) })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export * from './generated/client/index.js'
