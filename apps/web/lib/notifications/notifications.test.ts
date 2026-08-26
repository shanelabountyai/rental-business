import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChannelSendError } from './adapter.ts'
import { notificationAdapter } from './provider.ts'
import { dispatchPendingNotifications, notify } from './send.ts'

// The engine's guarantees against a real database. None of these can be
// proved by a unit test: every one of them is about what the DATABASE does -
// a unique constraint, an append-only trigger, two writers racing - and every
// one fails in a way that is expensive rather than merely wrong. A duplicate
// send is a duplicate text to a real tenant.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const notificationIds: string[] = []

/**
 * Retire delivery rows left QUEUED by earlier runs (R-102).
 *
 * In production the hourly cron is what drains this table. In the test
 * environment nothing plays that role: every spec that queues a notification
 * and then dispatches only its own rows - which is the isolation rule
 * CLAUDE.md requires - leaves the rest QUEUED for ever. The shared database
 * reached 27,392 delivery rows this way.
 *
 * That is invisible until one test sweeps globally. The spec below has to
 * pass a large batch to guarantee its own rows are reached (the sweep orders
 * by id and a fresh cuid sorts last), so it then SENDS the entire backlog -
 * two round trips per row, sequentially - and it outgrew its 60s timeout.
 *
 * BY OWNERSHIP, NOT BY AGE (R-109). The first version retired rows older
 * than an hour, on the argument that nothing a concurrently-running spec is
 * asserting on could be that old. True, and useless: one suite run leaves
 * thousands of rows behind and finishes in minutes, so inside the hour the
 * predicate matched NOTHING and the sweep below paid for the whole backlog
 * anyway - measured at 4,044 QUEUED deliveries, every one under an hour old.
 * It only ever worked on the first run in any hour, which is the shape of a
 * test that passes when you ask it to and fails when nobody is looking.
 *
 * Lowering the number is not the fix, because the number was never the
 * point: it was standing in for "nobody is still using this row". The
 * database already records that directly. Every spec here deactivates its
 * property in `afterAll` - it cannot DELETE it, because `Notification` is
 * append-only and the FK is ON DELETE SET NULL, which is an UPDATE the
 * trigger refuses - so an INACTIVE property is a spec that has finished, and
 * an ACTIVE one is a spec that may still be running. Retiring only the
 * former cannot touch a live fixture at any age, which is a stronger
 * guarantee than the hour gave, and it fires on debris the moment it is
 * debris. Checked against this database: all 235,013 notifications written
 * in the last two days hang off an inactive property, and none off an active
 * one.
 *
 * A notification with no property at all (a portfolio-wide digest) has no
 * ownership signal and is deliberately left alone.
 *
 * `NotificationDelivery` is not one of the append-only tables, so this is an
 * ordinary UPDATE - `Notification` is, and is deliberately left alone.
 */
async function retireStaleDeliveries() {
  await prisma.notificationDelivery.updateMany({
    where: {
      notification: { property: { active: false } },
      OR: [{ status: 'QUEUED' }, { status: 'DEFERRED' }],
    },
    data: { status: 'SUPPRESSED', suppressedReason: 'stale_test_fixture' },
  })
}

beforeAll(async () => {
  await retireStaleDeliveries()
  const stamp = `notif-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterEach(async () => {
  // NotificationDelivery is deliberately NOT trigger-protected, so it can be
  // cleaned up; Notification is, so it cannot. Rows created here are left
  // behind on purpose - see afterAll.
  await prisma.notificationDelivery.deleteMany({
    where: { notificationId: { in: notificationIds } },
  })
  await prisma.notificationPreference.deleteMany({
    where: { recipientId: { startsWith: 'test-' } },
  })
})

afterAll(async () => {
  // The property cannot be deleted while notifications reference it: the FK
  // is ON DELETE SET NULL, SET NULL is an UPDATE, and the append-only trigger
  // rejects an UPDATE. Deactivating is what every e2e spec already does for
  // the identical reason with AuditLog.
  await prisma.property.updateMany({
    where: { id: propertyId },
    data: { active: false },
  })
  await prisma.$disconnect()
})

/// A staff recipient with an email, so EMAIL and PORTAL are both candidates.
function recipient(id = `test-${randomUUID()}`) {
  return { type: 'STAFF' as const, id, email: 'ops@example.test' }
}

async function notifyOnce(
  overrides: Partial<Parameters<typeof notify>[0]> = {},
) {
  const outcomes = await notify({
    category: 'unit_make_ready',
    templateKey: 'unit.make_ready',
    recipient: recipient(),
    context: { propertyName: 'Test House', unitName: 'ADU' },
    propertyId,
    idempotencyKey: `test:${randomUUID()}`,
    // Mid-morning Chicago, so nothing defers unless a test asks for it.
    now: new Date('2026-08-05T15:00:00Z'),
    ...overrides,
  })
  const created = await prisma.notification.findMany({
    where: {
      idempotencyKey: {
        startsWith: (overrides.idempotencyKey ?? '') || 'test:',
      },
    },
  })
  notificationIds.push(...created.map((row) => row.id))
  return outcomes
}

describe('idempotency', () => {
  it('records one notification per channel on the first call', async () => {
    const key = `test:${randomUUID()}`
    const outcomes = await notifyOnce({ idempotencyKey: key })

    expect(outcomes.map((o) => o.outcome)).toEqual(['recorded', 'recorded'])
    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(...rows.map((r) => r.id))
    // The template ships EMAIL and PORTAL variants.
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.channel))).toEqual(
      new Set(['EMAIL', 'PORTAL']),
    )
  })

  it('writes nothing on a second call with the same key', async () => {
    const key = `test:${randomUUID()}`
    const who = recipient()
    const args = {
      category: 'unit_make_ready' as const,
      templateKey: 'unit.make_ready',
      recipient: who,
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    }

    await notify(args)
    const second = await notify(args)

    expect(second.every((o) => o.outcome === 'duplicate')).toBe(true)
    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(...rows.map((r) => r.id))
    expect(rows).toHaveLength(2)
  })

  it('lets exactly one of five simultaneous calls win', async () => {
    // The real shape of the race: an outbox consumer retried while the
    // previous attempt is still in flight, or a cron overlapping itself.
    const key = `test:${randomUUID()}`
    const who = recipient()
    const args = {
      category: 'unit_make_ready' as const,
      templateKey: 'unit.make_ready',
      recipient: who,
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    }

    const results = await Promise.all(
      Array.from({ length: 5 }, () => notify(args)),
    )
    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(...rows.map((r) => r.id))

    expect(rows).toHaveLength(2)
    const recorded = results
      .flat()
      .filter((outcome) => outcome.outcome === 'recorded')
    expect(recorded).toHaveLength(2)
  })
})

describe('preferences', () => {
  it('records a suppressed row rather than silently sending nothing', async () => {
    const who = recipient()
    await prisma.notificationPreference.create({
      data: {
        recipientType: 'STAFF',
        recipientId: who.id,
        category: 'unit_make_ready',
        channel: 'EMAIL',
        enabled: false,
      },
    })

    const key = `test:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: who,
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(...rows.map((r) => r.id))

    const email = rows.find((r) => r.channel === 'EMAIL')
    expect(email?.delivery?.status).toBe('SUPPRESSED')
    expect(email?.delivery?.suppressedReason).toBe('preference_off')
    // The body is still rendered and stored: "what we would have said" is
    // part of answering why they did not get it.
    expect(email?.body).toContain('ADU')
  })

  it('records no_address for a recipient with nothing to reach them on', async () => {
    const key = `test:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: { type: 'STAFF', id: `test-${randomUUID()}` },
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(...rows.map((r) => r.id))

    // PORTAL always has an "address" (the account itself), so only EMAIL is
    // address-less here.
    const email = rows.find((r) => r.channel === 'EMAIL')
    expect(email?.delivery?.status).toBe('SUPPRESSED')
    expect(email?.delivery?.suppressedReason).toBe('no_address')
  })
})

describe('quiet hours', () => {
  it('defers a routine notification that arrives at 22:00 local', async () => {
    const key = `test:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: recipient(),
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      // 03:00 UTC = 22:00 the previous evening in Chicago.
      now: new Date('2026-08-05T03:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(...rows.map((r) => r.id))

    for (const row of rows) {
      expect(row.delivery?.status).toBe('DEFERRED')
      // Held, not discarded - and due at the next local 08:00, which is
      // 13:00 UTC in August.
      expect(row.delivery?.sendAfter?.toISOString()).toBe(
        '2026-08-05T13:00:00.000Z',
      )
    }
  })

  it('does not defer an emergency', async () => {
    // maintenance_emergency is the one category that bypasses quiet hours.
    // It has no template of its own yet (R-020 owns that), so this asserts
    // the decision through the category rather than through a send.
    const { bypassesQuietHours } = await import('@rental/core/notifications')
    expect(bypassesQuietHours('maintenance_emergency')).toBe(true)
    expect(bypassesQuietHours('unit_make_ready')).toBe(false)
  })
})

describe('dispatch', () => {
  it('sends a queued notification once, even when dispatched twice', async () => {
    const key = `test:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: recipient(),
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: { select: { id: true } } },
    })
    notificationIds.push(...rows.map((r) => r.id))

    // SCOPED to this test's own deliveries. What is being proved is that
    // dispatching twice sends once - the once-only guarantee - and that
    // holds identically whether the sweep is filtered or not. An unfiltered
    // sweep here would additionally send whatever the rest of the suite has
    // queued in parallel, which is unbounded work inside a test timeout and
    // is how this test started failing for a reason unrelated to what it
    // checks. The global sweep has its own test below.
    const only = {
      deliveryIds: rows
        .map((r) => r.delivery?.id)
        .filter((id): id is string => id != null),
    }
    await dispatchPendingNotifications(new Date(), 100, only)
    await dispatchPendingNotifications(new Date(), 100, only)

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { notificationId: { in: rows.map((r) => r.id) } },
    })
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('SENT')
      expect(delivery.sentAt).not.toBeNull()
      expect(delivery.externalId).toMatch(/^log_/)
      // The second dispatch found it already SENT and left it alone rather
      // than sending again.
      expect(delivery.attempts).toBe(1)
    }
  })

  it('leaves a deferred notification alone until its time comes', async () => {
    const key = `test:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: recipient(),
      context: { propertyName: 'Test House', unitName: 'ADU' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T03:00:00Z'),
    })
    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: { select: { id: true } } },
    })
    notificationIds.push(...rows.map((r) => r.id))

    // SCOPED to this test's own deliveries. What is under test is
    // quiet-hours deferral, which holds identically filtered or not - and an
    // unfiltered sweep here would additionally send whatever the rest of the
    // suite has queued in parallel, which is unbounded work inside a test
    // timeout. The global path has its own test below.
    const only = {
      deliveryIds: rows
        .map((r) => r.delivery?.id)
        .filter((id): id is string => id != null),
    }

    // Still 04:00 UTC (23:00 local) - inside quiet hours.
    await dispatchPendingNotifications(new Date('2026-08-05T04:00:00Z'), 100, only)
    let deliveries = await prisma.notificationDelivery.findMany({
      where: { notificationId: { in: rows.map((r) => r.id) } },
    })
    expect(deliveries.every((d) => d.status === 'DEFERRED')).toBe(true)

    // 14:00 UTC is 09:00 local, past the 08:00 resume.
    await dispatchPendingNotifications(new Date('2026-08-05T14:00:00Z'), 100, only)
    deliveries = await prisma.notificationDelivery.findMany({
      where: { notificationId: { in: rows.map((r) => r.id) } },
    })
    expect(deliveries.every((d) => d.status === 'SENT')).toBe(true)
  })
})

describe('scoped dispatch', () => {
  /// Queues one notification and returns the delivery ids `notify()` reported.
  async function queueOne(label: string) {
    const key = `test:${label}:${randomUUID()}`
    const outcomes = await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: recipient(),
      context: { propertyName: 'Test House', unitName: label },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-05T15:00:00Z'),
    })
    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(...rows.map((r) => r.id))
    return {
      notificationIds: rows.map((r) => r.id),
      deliveryIds: outcomes
        .map((o) => o.deliveryId)
        .filter((id): id is string => id != null),
    }
  }

  it('reports the delivery it just wrote, so a caller can send exactly that', async () => {
    const queued = await queueOne('reports')
    expect(queued.deliveryIds.length).toBeGreaterThan(0)
  })

  it('SENDS ONLY the deliveries it was given, leaving the rest queued', async () => {
    // The bug this pins: an inline caller (R-020's emergency page, R-025's
    // vendor dispatch, R-026's bid requests) used to flush the GLOBAL queue,
    // paying for everyone else's backlog and - because the sweep takes the
    // oldest rows in id order - potentially not sending its own message at
    // all. A tenant reporting sewage waited on unrelated notifications.
    const mine = await queueOne('mine')
    const theirs = await queueOne('theirs')

    await dispatchPendingNotifications(new Date(), 100, {
      deliveryIds: mine.deliveryIds,
    })

    const minePending = await prisma.notificationDelivery.findMany({
      where: { id: { in: mine.deliveryIds } },
    })
    for (const delivery of minePending) {
      expect(delivery.status, 'my own page should have gone').toBe('SENT')
    }

    const theirsPending = await prisma.notificationDelivery.findMany({
      where: { id: { in: theirs.deliveryIds } },
    })
    for (const delivery of theirsPending) {
      expect(delivery.status, "somebody else's queue is not mine to flush").toBe('QUEUED')
    }
  })

  it('sends NOTHING for an explicitly empty set rather than falling back to a global sweep', async () => {
    // Every channel suppressed is a real outcome, and it must not be
    // indistinguishable from "no filter given".
    const untouched = await queueOne('untouched')

    const result = await dispatchPendingNotifications(new Date(), 100, { deliveryIds: [] })
    expect(result).toEqual({ sent: 0, failed: 0, remaining: 0 })

    const still = await prisma.notificationDelivery.findMany({
      where: { id: { in: untouched.deliveryIds } },
    })
    for (const delivery of still) {
      expect(delivery.status).toBe('QUEUED')
    }
  })

  it('still sweeps globally when given no filter - which is what the cron is for', async () => {
    const queued = await queueOne('global')
    // Unfiltered IS the point here - this is the one test that proves the
    // cron's own path. The batch has to be large enough that a parallel
    // suite's backlog cannot crowd this test's rows out of it (the sweep
    // orders by id, and a fresh cuid sorts last), and the timeout has to
    // allow for actually sending that backlog.
    await dispatchPendingNotifications(new Date(), 5_000)
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { id: { in: queued.deliveryIds } },
    })
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('SENT')
    }
  }, 60_000)
})

describe('the append-only log', () => {
  it('refuses an update to a recorded notification', async () => {
    const key = `test:${randomUUID()}`
    await notifyOnce({ idempotencyKey: key })
    const row = await prisma.notification.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(row.id)

    await expect(
      prisma.notification.update({
        where: { id: row.id },
        data: { body: 'rewritten after the fact' },
      }),
    ).rejects.toThrow(/append-only/)
  })

  it('refuses a delete', async () => {
    const key = `test:${randomUUID()}`
    await notifyOnce({ idempotencyKey: key })
    const row = await prisma.notification.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: key } },
    })
    notificationIds.push(row.id)

    await expect(
      prisma.notification.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/append-only/)
  })

  it('still allows the delivery half to move', async () => {
    // The whole point of the split: the provider's answer legitimately
    // changes after the fact, and must not require touching the evidence.
    const key = `test:${randomUUID()}`
    await notifyOnce({ idempotencyKey: key })
    const row = await prisma.notification.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(row.id)

    const updated = await prisma.notificationDelivery.update({
      where: { id: row.delivery!.id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    })
    expect(updated.status).toBe('DELIVERED')
  })
})

describe('the kill switch', () => {
  it('records every channel as suppressed and sends nothing', async () => {
    const previous = process.env.NOTIFICATIONS_ENABLED
    process.env.NOTIFICATIONS_ENABLED = 'false'
    try {
      const key = `test:${randomUUID()}`
      await notify({
        category: 'unit_make_ready',
        templateKey: 'unit.make_ready',
        recipient: recipient(),
        context: { propertyName: 'Test House', unitName: 'ADU' },
        propertyId,
        idempotencyKey: key,
        now: new Date('2026-08-05T15:00:00Z'),
      })

      const rows = await prisma.notification.findMany({
        where: { idempotencyKey: { startsWith: key } },
        include: { delivery: true },
      })
      notificationIds.push(...rows.map((r) => r.id))

      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.delivery?.status).toBe('SUPPRESSED')
        expect(row.delivery?.suppressedReason).toBe('kill_switch')
      }

      // And the dispatcher refuses to run at all while it is off.
      const result = await dispatchPendingNotifications()
      expect(result).toEqual({ sent: 0, failed: 0, remaining: 0 })
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATIONS_ENABLED
      else process.env.NOTIFICATIONS_ENABLED = previous
    }
  })
})

// R-106a: A FAILED DELIVERY IS NOT A FINISHED DELIVERY.
//
// `failureCode` was written in four places and branched on in none, so a
// Twilio 500 and a disconnected number were both permanent. These are about
// the branch, and about what the row says while it waits - a retry that
// erased the failure it was retrying would trade one silent record for
// another.
describe('retrying a failed delivery', () => {
  const AT = new Date('2026-08-05T15:00:00Z')

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function dispatchOneFailing(code: string) {
    const key = `test:retry:${randomUUID()}`
    const outcomes = await notifyOnce({ idempotencyKey: key })
    const deliveryIds = outcomes
      .map((o) => o.deliveryId)
      .filter((id): id is string => id !== undefined)

    vi.spyOn(notificationAdapter, 'send').mockRejectedValue(
      new ChannelSendError(code, `simulated ${code}`),
    )
    const result = await dispatchPendingNotifications(AT, 100, { deliveryIds })
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { id: { in: deliveryIds } },
    })
    return { result, deliveries }
  }

  it('parks a transient failure on a backoff instead of burying it', async () => {
    const { result, deliveries } = await dispatchOneFailing('http_500')

    // NOT counted as failed: the sweep has not finished with it.
    expect(result.failed).toBe(0)
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('DEFERRED')
      // 15 minutes, the first rung of the backoff.
      expect(delivery.sendAfter).toEqual(new Date('2026-08-05T15:15:00Z'))
      // The row still says what went wrong and when, while it waits. Without
      // this a message that has been failing for four hours is
      // indistinguishable from one merely held until morning.
      expect(delivery.failureCode).toBe('http_500')
      expect(delivery.failedAt).not.toBeNull()
      expect(delivery.attempts).toBe(1)
    }
  })

  it('does not retry a send the provider already accepted', async () => {
    // no_id means Resend took the email and returned something we could not
    // read an id out of. A retry sends it twice.
    const { result, deliveries } = await dispatchOneFailing('no_id')

    expect(result.failed).toBe(deliveries.length)
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('FAILED')
      expect(delivery.sendAfter).toBeNull()
    }
  })

  it('gives up after three attempts rather than retrying for ever', async () => {
    const key = `test:retry-exhausted:${randomUUID()}`
    const outcomes = await notifyOnce({ idempotencyKey: key })
    const deliveryIds = outcomes
      .map((o) => o.deliveryId)
      .filter((id): id is string => id !== undefined)
    // Two attempts already spent; the claim in the sweep makes this the third
    // and last.
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: deliveryIds } },
      data: { attempts: 2 },
    })

    vi.spyOn(notificationAdapter, 'send').mockRejectedValue(
      new ChannelSendError('http_503', 'still down'),
    )
    await dispatchPendingNotifications(AT, 100, { deliveryIds })
    const third = await prisma.notificationDelivery.findMany({
      where: { id: { in: deliveryIds } },
    })
    // The last rung: four hours out, not given up on yet.
    expect(third[0]?.status).toBe('DEFERRED')
    expect(third[0]?.sendAfter).toEqual(new Date('2026-08-05T19:00:00Z'))

    // And the one after that is terminal.
    await dispatchPendingNotifications(new Date('2026-08-05T19:01:00Z'), 100, {
      deliveryIds,
    })
    const fourth = await prisma.notificationDelivery.findMany({
      where: { id: { in: deliveryIds } },
    })
    for (const delivery of fourth) {
      expect(delivery.status).toBe('FAILED')
      expect(delivery.attempts).toBe(4)
    }
  })

  it('does not let a retry land inside quiet hours', async () => {
    // A send that fails at 20:55 local backs off four hours. Without the
    // quiet-hours push that is a text at one in the morning - NOTIF-05 does
    // not stop applying because the first attempt failed.
    const key = `test:retry-quiet:${randomUUID()}`
    const outcomes = await notifyOnce({ idempotencyKey: key })
    const deliveryIds = outcomes
      .map((o) => o.deliveryId)
      .filter((id): id is string => id !== undefined)
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: deliveryIds } },
      data: { attempts: 2 },
    })

    vi.spyOn(notificationAdapter, 'send').mockRejectedValue(
      new ChannelSendError('http_503', 'still down'),
    )
    // 01:55Z on the 6th is 20:55 Chicago on the 5th; +4h is 00:55 local.
    await dispatchPendingNotifications(new Date('2026-08-06T01:55:00Z'), 100, {
      deliveryIds,
    })
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { id: { in: deliveryIds } },
    })
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('DEFERRED')
      expect(delivery.sendAfter!.getTime()).toBeGreaterThan(
        new Date('2026-08-06T05:55:00Z').getTime(),
      )
    }
  })
})
