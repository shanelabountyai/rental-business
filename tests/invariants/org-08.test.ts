import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@rental/db'
import { GET as daily } from '@/app/api/cron/route.ts'
import { GET as escalations } from '@/app/api/cron/escalations/route.ts'
import { GET as notifications } from '@/app/api/cron/notifications/route.ts'
import { type Org, retire, rowOf, seedOrgWith } from './fixture.ts'

// ORG-08 (PRD 10 §1.5, R-290): every cron and sweep run as org A touches no
// org-B row. Checked on the rows, not on the queries: every org-B row of every
// org-owned model is snapshotted, all three cron routes run for org A, and the
// snapshot must come back identical - no row created, changed or removed.
//
// The control runs the same routes for org B and requires that snapshot to
// CHANGE. Without it a fixture with no due work would pass for nothing: org B
// is given a queued delivery, an unpublished event, a listing to delist, a
// showing to remind and an emergency nobody acknowledged.

const ORG_MODELS = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'orgId'))
const lower = (m: string) => m[0]!.toLowerCase() + m.slice(1)
const json = (row: unknown) => JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

/** Every row org `orgId` owns, per model, as sorted JSON. */
async function snapshot(orgId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const m of ORG_MODELS) {
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown[]> }>)[lower(m.name)]!
    out.set(m.name, (await delegate.findMany({ where: { orgId } })).map(json).sort())
  }
  return out
}

function changedModels(before: Map<string, string[]>, after: Map<string, string[]>): string[] {
  return [...before.keys()].filter((m) => json(before.get(m)) !== json(after.get(m)))
}

const SECRET = 'org-08-cron-secret'
const runCronAs = async (orgId: string) => {
  const call = (path: string) =>
    new Request(`http://localhost/api/cron${path}?org=${orgId}`, { headers: { authorization: `Bearer ${SECRET}` } })
  for (const [path, route] of [['', daily], ['/escalations', escalations], ['/notifications', notifications]] as const) {
    const response = await route(call(path))
    expect(response.status, `${path || '/'} for ${orgId}: ${await response.clone().text()}`).toBe(200)
  }
}

/** Gives org `o` work every sweep would pick up. */
async function giveDueWork(o: Org) {
  const now = Date.now()
  await prisma.notificationDelivery.update({
    where: { id: await rowOf(o, 'notificationDelivery') },
    data: { status: 'QUEUED', attempts: 0 },
  })
  await prisma.outboxEvent.update({
    where: { id: await rowOf(o, 'outboxEvent') },
    data: { publishedAt: null, attempts: 0 },
  })
  const syndication = await prisma.listingSyndication.update({
    where: { id: await rowOf(o, 'listingSyndication') },
    data: { status: 'LISTED', externalId: `org-08-${o.key}-${now}` },
    select: { listingId: true },
  })
  await prisma.listing.update({ where: { id: syndication.listingId }, data: { status: 'UNPUBLISHED' } })
  await prisma.showing.update({
    where: { id: await rowOf(o, 'showing') },
    data: {
      status: 'BOOKED',
      scheduledStart: new Date(now + 23.5 * 3_600_000),
      scheduledEnd: new Date(now + 24 * 3_600_000),
    },
  })
  await prisma.ticket.update({
    where: { id: await rowOf(o, 'ticket') },
    data: { priority: 'EMERGENCY', emergencyAt: new Date(now - 20 * 60_000), acknowledgedAt: null },
  })
}

const MODELS = ['notificationDelivery', 'outboxEvent', 'listingSyndication', 'showing', 'ticket']
const seeded: Org[] = []
let a: Org
let b: Org
let previousSecret: string | undefined

beforeAll(async () => {
  previousSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = SECRET
  a = await seedOrgWith('a', MODELS)
  b = await seedOrgWith('b', MODELS)
  seeded.push(a, b)
  await giveDueWork(a)
  await giveDueWork(b)
}, 120_000)

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = previousSecret
  await retire(seeded)
})

describe('ORG-08: crons and sweeps per organisation', () => {
  it('running every cron as org A leaves every org-B row exactly as it was', async () => {
    const before = await snapshot(b.id)
    await runCronAs(a.id)
    expect(changedModels(before, await snapshot(b.id))).toEqual([])
  }, 120_000)

  it("control: running them as org B does change org B's rows", async () => {
    const before = await snapshot(b.id)
    await runCronAs(b.id)
    expect(changedModels(before, await snapshot(b.id))).toEqual(
      expect.arrayContaining(['NotificationDelivery', 'OutboxEvent', 'ListingSyndication', 'JobRun']),
    )
  }, 120_000)

  it('an unknown org is a 404, the same answer as a wrong token', async () => {
    const response = await daily(
      new Request('http://localhost/api/cron?org=no-such-org', { headers: { authorization: `Bearer ${SECRET}` } }),
    )
    expect(response.status).toBe(404)
  })

  it("the daily tick claims each org once per day: a second delivery is a no-op", async () => {
    const response = await daily(
      new Request(`http://localhost/api/cron?org=${a.id}`, { headers: { authorization: `Bearer ${SECRET}` } }),
    )
    expect(await response.json()).toEqual({ ok: true, claim: 'already_ran' })
  })
})
