import { timingSafeEqual } from 'node:crypto'
import { auditAsSystem } from '@/lib/audit/index.ts'
import { dispatchOutbox } from '@/lib/jobs/outbox.ts'
import { runDueJobs } from '@/lib/jobs/runner.ts'

// The single scheduled entry point. Vercel Cron hits it hourly (vercel.json),
// and the runner decides which properties are due in their own local time -
// D-3, restated: there is no UTC-midnight job in this product.
//
// Hourly rather than nightly on purpose. A nightly UTC job would have to pick
// one moment for a portfolio spanning several timezones, and would be wrong
// for all but one of them. Hourly ticks let each property's own 02:00 arrive
// whenever it arrives.

export const runtime = 'nodejs'
/// Never cached, never prerendered - it has side effects and reads a header.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    // 404, not 401. An unauthenticated caller learns nothing about whether
    // this endpoint exists, and a scanner gets no signal to come back.
    return new Response('Not found', { status: 404 })
  }

  const startedAt = Date.now()

  // Jobs first, then dispatch: a job that emits an event gets it delivered in
  // the same tick rather than waiting an hour for the next one.
  const runs = await runDueJobs()
  const dispatch = await dispatchOutbox()

  const ran = runs.filter((r) => r.outcome === 'ran')
  const failures = runs.filter((r) => r.outcome === 'failed')

  if (failures.length > 0) {
    // Recorded rather than logged: a nightly job that failed silently is how a
    // month of missing late fees happens. AuditLog is append-only, so this is
    // still there when someone finally asks.
    await auditAsSystem('cron', {
      action: 'job.failed',
      entityType: 'JobRun',
      entityId: 'cron',
      after: { failures },
    }).catch(() => {
      // An audit failure must not swallow the response the cron needs to see.
    })
  }

  return Response.json({
    ok: failures.length === 0,
    ranJobs: ran.length,
    failedJobs: failures.length,
    notDue: runs.filter((r) => r.outcome === 'not_due').length,
    alreadyRan: runs.filter((r) => r.outcome === 'already_ran').length,
    eventsPublished: dispatch.published,
    eventsFailed: dispatch.failed,
    durationMs: Date.now() - startedAt,
  })
}

/**
 * Bearer token comparison, in constant time.
 *
 * Refuses everything when CRON_SECRET is unset - which .env.example already
 * demands. Defaulting to open would make a missing environment variable in a
 * new deployment into an unauthenticated endpoint that runs every scheduled
 * job in the product on request.
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false

  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return false

  const provided = Buffer.from(header.slice('Bearer '.length))
  const secret = Buffer.from(expected)
  // Length is checked first because timingSafeEqual throws on a mismatch. The
  // length of a secret is not the secret.
  return provided.length === secret.length && timingSafeEqual(provided, secret)
}
