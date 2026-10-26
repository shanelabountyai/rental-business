import 'server-only'

import { businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { isAuthorizedCron } from '@/lib/cron/authorize.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'

// Every cron route, per organisation (R-290, PRD 10 §M6).
//
// ONE INVOCATION PER ORG, NOT ONE LOOP OVER ORGS. Vercel gives a function 60
// seconds; a loop shares them, so the org that happens to come first and is
// slow takes the time every later org needed, and a deadline-and-rotate
// scheme only changes WHICH org starves. Vercel Cron hits the route with no
// `org`; the route calls itself once per org with `?org=<id>` and the same
// bearer token, and each of those is its own invocation with its own 60
// seconds. A child that dies or times out is one org's failure, recorded
// against that org, and the others have already finished on their own.
//
// ponytail: every org at once. Each child opens its own pool, so at a few
// dozen orgs this wants batches of ten; at two it does not.

export type OrgRunResult = { ok: boolean } & Record<string, unknown>

/**
 * The whole of a cron route: authorize, then fan out (no `org`) or run one
 * org (`?org=`). 404 for a bad token AND for an unknown org, so neither tells
 * a scanner anything (the route's own reasoning, unchanged).
 */
export async function cronRoute(
  request: Request,
  runForOrg: (orgId: string) => Promise<OrgRunResult>,
): Promise<Response> {
  if (!isAuthorizedCron(request)) return new Response('Not found', { status: 404 })

  const orgId = new URL(request.url).searchParams.get('org')
  if (orgId === null) return Response.json(await fanOut(request))

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })
  if (!org) return new Response('Not found', { status: 404 })

  try {
    return Response.json(await runForOrg(orgId))
  } catch (error) {
    // A 500 the parent reads as this org's failure. Nobody else's run is
    // affected - they are separate invocations.
    return Response.json({ ok: false, error: messageOf(error) }, { status: 500 })
  }
}

async function fanOut(request: Request) {
  const startedAt = Date.now()
  const orgs = await prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
  const authorization = request.headers.get('authorization') ?? ''

  const results = await Promise.all(
    orgs.map(async ({ id }): Promise<[string, OrgRunResult]> => {
      const url = new URL(request.url)
      url.search = ''
      url.searchParams.set('org', id)
      try {
        const response = await fetch(url, { headers: { authorization }, cache: 'no-store' })
        const body = (await response.json().catch(() => null)) as OrgRunResult | null
        return [id, body ?? { ok: false, error: `HTTP ${response.status}` }]
      } catch (error) {
        return [id, { ok: false, error: messageOf(error) }]
      }
    }),
  )

  for (const [orgId, result] of results) {
    if (result.ok) continue
    // Recorded rather than logged, against the org it happened to - the
    // child's own job failures are already audited by the child.
    await auditAsSystem('cron', {
      action: 'job.failed',
      entityType: 'Organization',
      entityId: orgId,
      orgId,
      after: { path: new URL(request.url).pathname, result } as Prisma.InputJsonObject,
    }).catch(() => {
      // An audit failure must not swallow the response the cron needs to see.
    })
  }

  return {
    ok: results.every(([, result]) => result.ok),
    orgs: Object.fromEntries(results),
    durationMs: Date.now() - startedAt,
  }
}

/// A claim nobody finished inside this is a child Vercel killed at its 60
/// seconds; the next tick may take it back.
const ORG_CLAIM_STALE_MS = 5 * 60_000

/**
 * One portfolio-wide `JobRun` per (jobType, org, UTC day) - the daily tick's
 * per-org claim. Claiming IS the lock, as in the runner: a double delivery
 * from Vercel Cron runs an org once. A FAILED or abandoned claim is taken back
 * rather than refused, because the work under it is idempotent per property
 * and per row, and an org whose tick crashed must not wait until tomorrow.
 */
export async function withOrgClaim(
  jobType: string,
  orgId: string,
  now: Date,
  run: () => Promise<OrgRunResult>,
): Promise<OrgRunResult> {
  const businessDate = businessDateToUtc(utcToBusinessDate(now))
  let id: string
  try {
    ;({ id } = await prisma.jobRun.create({
      data: { jobType, orgId, propertyId: null, businessDate, status: 'RUNNING' },
      select: { id: true },
    }))
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retaken = await prisma.jobRun.updateManyAndReturn({
      where: {
        jobType,
        orgId,
        propertyId: null,
        businessDate,
        OR: [
          { status: 'FAILED' },
          { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - ORG_CLAIM_STALE_MS) } },
        ],
      },
      data: { status: 'RUNNING', startedAt: new Date(), error: null, finishedAt: null, attempts: { increment: 1 } },
      select: { id: true },
    })
    if (retaken.length === 0) return { ok: true, claim: 'already_ran' }
    id = retaken[0]!.id
  }

  try {
    const result = await run()
    await prisma.jobRun.update({
      where: { id },
      data: {
        status: result.ok ? 'SUCCEEDED' : 'FAILED',
        result: result as Prisma.InputJsonObject,
        finishedAt: new Date(),
      },
    })
    return { ...result, claim: 'ran' }
  } catch (error) {
    await prisma.jobRun.update({
      where: { id },
      data: { status: 'FAILED', error: messageOf(error), finishedAt: new Date() },
    })
    throw error
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
