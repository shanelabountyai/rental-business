import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CONSUMERS, dispatchOutbox, emitEvent } from './outbox.ts'
import { SCHEDULED_JOBS, rerunJobRun, runDueJobs } from './runner.ts'

// The two idempotency guarantees, against a real database. Neither can be
// proved by unit tests: both are about what the DATABASE does when two things
// happen at once, and both fail open in the most expensive possible way -
// charges posted twice, notifications sent twice.

const CHICAGO = 'America/Chicago'
const HONOLULU = 'Pacific/Honolulu'

let entityId: string
let chicagoPropertyId: string
let honoluluPropertyId: string

beforeAll(async () => {
  const stamp = `jobs-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id

  const make = async (name: string, timezone: string) =>
    prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Test',
        state: 'TX',
        postalCode: '77002',
        timezone,
        propertyType: 'SINGLE_FAMILY',
      },
    })
  chicagoPropertyId = (await make('chicago', CHICAGO)).id
  honoluluPropertyId = (await make('honolulu', HONOLULU)).id
})

afterEach(async () => {
  SCHEDULED_JOBS.length = 0
  CONSUMERS.length = 0
  await prisma.task.deleteMany({
    where: { propertyId: { in: [chicagoPropertyId, honoluluPropertyId] } },
  })
  await prisma.jobRun.deleteMany({
    where: { propertyId: { in: [chicagoPropertyId, honoluluPropertyId] } },
  })
  await prisma.eventConsumption.deleteMany({
    where: { event: { propertyId: chicagoPropertyId } },
  })
  await prisma.outboxEvent.deleteMany({
    where: { propertyId: chicagoPropertyId },
  })
})

afterAll(async () => {
  await prisma.property.deleteMany({
    where: { id: { in: [chicagoPropertyId, honoluluPropertyId] } },
  })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

/**
 * runDueJobs deliberately iterates every active property, and other test files
 * create their own - vitest runs files in parallel, so those show up here.
 * Every assertion in this file is therefore scoped to the two properties it
 * created, and the job bodies below ignore anything else.
 */
function isOurs(propertyId: string) {
  return [chicagoPropertyId, honoluluPropertyId].includes(propertyId)
}

/** Only our two test properties, so other rows in the dev DB cannot interfere. */
async function runForTestProperties(now: Date) {
  return runDueJobs(now, {
    propertyIds: [chicagoPropertyId, honoluluPropertyId],
  })
}

describe('the scheduled job runner', () => {
  it('runs a due job once and records the run', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.nightly',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        calls++
        return { touched: 1 }
      },
    })

    // 07:00 UTC is 02:00 in Chicago and 21:00 the previous day in Honolulu -
    // both past hour 2, so both are due, on DIFFERENT business dates.
    const summaries = await runForTestProperties(
      new Date('2026-08-04T07:00:00Z'),
    )
    expect(calls).toBe(2)
    expect(summaries.every((s) => s.outcome === 'ran')).toBe(true)

    const runs = await prisma.jobRun.findMany({
      where: {
        jobType: 'test.nightly',
        propertyId: { in: [chicagoPropertyId, honoluluPropertyId] },
      },
      orderBy: { businessDate: 'asc' },
    })
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === 'SUCCEEDED')).toBe(true)
    expect(runs[0]!.result).toEqual({ touched: 1 })
  })

  // The hourly cron keeps ticking and `isDue` keeps returning true for the
  // rest of the local day. Without the unique index that means twenty-two more
  // runs, and twenty-two more sets of charges.
  it('does not run a second time later the same local day', async () => {
    const calls: string[] = []
    SCHEDULED_JOBS.push({
      type: 'test.nightly',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        calls.push(`${context.propertyId}:${context.businessDate}`)
      },
    })

    // Three consecutive hourly ticks, all within one Chicago day.
    await runForTestProperties(new Date('2026-08-04T07:00:00Z')) // 02:00 CDT
    await runForTestProperties(new Date('2026-08-04T08:00:00Z')) // 03:00 CDT
    await runForTestProperties(new Date('2026-08-04T12:00:00Z')) // 07:00 CDT

    // Chicago: one run, despite the due check staying true for all three.
    expect(calls.filter((c) => c.startsWith(chicagoPropertyId))).toEqual([
      `${chicagoPropertyId}:2026-08-04`,
    ])
    expect(
      await prisma.jobRun.count({
        where: { jobType: 'test.nightly', propertyId: chicagoPropertyId },
      }),
    ).toBe(1)

    // Honolulu: TWO runs, and that is correct rather than a leak. Those same
    // three instants are 21:00 and 22:00 on the 3rd, then 02:00 on the 4th -
    // its local day rolled over mid-sequence, so it owes a run for each. This
    // is D-3 doing exactly its job: one UTC-keyed run would have filed both
    // under the wrong day for at least one of these two properties.
    expect(calls.filter((c) => c.startsWith(honoluluPropertyId))).toEqual([
      `${honoluluPropertyId}:2026-08-03`,
      `${honoluluPropertyId}:2026-08-04`,
    ])
  })

  it('runs again on the next local day', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.nightly',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (isOurs(context.propertyId)) calls++
      },
    })

    await runForTestProperties(new Date('2026-08-04T07:00:00Z'))
    await runForTestProperties(new Date('2026-08-05T07:00:00Z'))

    const chicago = await prisma.jobRun.findMany({
      where: { jobType: 'test.nightly', propertyId: chicagoPropertyId },
      orderBy: { businessDate: 'asc' },
    })
    expect(chicago).toHaveLength(2)
    expect(chicago.map((r) => r.businessDate.toISOString().slice(0, 10))).toEqual(
      ['2026-08-04', '2026-08-05'],
    )
    expect(calls).toBe(4)
  })

  it('does not run before the target local hour', async () => {
    SCHEDULED_JOBS.push({
      type: 'test.nightly',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (isOurs(context.propertyId)) throw new Error('must not run')
      },
    })

    // 06:00 UTC is 01:00 in Chicago - an hour early.
    const summaries = await runForTestProperties(
      new Date('2026-08-04T06:00:00Z'),
    )
    const chicago = summaries.find((s) => s.propertyId === chicagoPropertyId)
    expect(chicago!.outcome).toBe('not_due')
  })

  // The fall-back night. 01:00 local happens twice, so the cron ticks the job
  // as due at two different instants under the SAME business date.
  it('runs once across a duplicated DST hour', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.dst',
      localHour: 1,
      description: 'test',
      run: async (context) => {
        if (isOurs(context.propertyId)) calls++
      },
    })

    await runForTestProperties(new Date('2026-11-01T06:30:00Z')) // 01:30 CDT
    await runForTestProperties(new Date('2026-11-01T07:30:00Z')) // 01:30 CST

    const chicago = await prisma.jobRun.findMany({
      where: { jobType: 'test.dst', propertyId: chicagoPropertyId },
    })
    expect(chicago).toHaveLength(1)
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(
      chicago[0]!.businessDate.toISOString().slice(0, 10),
    ).toBe('2026-11-01')
  })

  // Claiming the run IS the lock. Two cron invocations overlapping - a retry, a
  // slow previous run, two regions - must not both execute the job.
  it('lets only one of two concurrent runners execute the job', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.concurrent',
      localHour: 0,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        calls++
        await new Promise((resolve) => setTimeout(resolve, 50))
      },
    })

    const now = new Date('2026-08-04T12:00:00Z')
    await Promise.all([
      runForTestProperties(now),
      runForTestProperties(now),
      runForTestProperties(now),
    ])

    expect(calls).toBe(2) // once per property, despite three concurrent runners
  })

  it('records a failure and does not retry it on the next tick', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.failing',
      localHour: 0,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        calls++
        throw new Error('boom')
      },
    })

    const first = await runForTestProperties(new Date('2026-08-04T12:00:00Z'))
    expect(first.every((s) => s.outcome === 'failed')).toBe(true)

    // The failed run row stays, so the next tick sees the day as claimed. A
    // retry is a deliberate act, not something the cron does sixty times
    // before anyone notices.
    await runForTestProperties(new Date('2026-08-04T13:00:00Z'))
    expect(calls).toBe(2)

    const run = await prisma.jobRun.findFirstOrThrow({
      where: { jobType: 'test.failing', propertyId: chicagoPropertyId },
    })
    expect(run.status).toBe('FAILED')
    expect(run.error).toContain('boom')
    expect(run.finishedAt).not.toBeNull()
  })

  it('reports a property with an unusable timezone instead of skipping it', async () => {
    const broken = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `broken-${Date.now()}`,
        addressLine1: '1 Test St',
        city: 'Test',
        state: 'TX',
        postalCode: '77002',
        timezone: 'Mars/Olympus_Mons',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    SCHEDULED_JOBS.push({
      type: 'test.tz',
      localHour: 0,
      description: 'test',
      run: async () => {},
    })

    const summaries = await runDueJobs(new Date('2026-08-04T12:00:00Z'), {
      propertyIds: [broken.id],
    })
    const failure = summaries.find((s) => s.propertyId === broken.id)
    // Silently skipping would leave every nightly job for this property wrong
    // forever with nothing to notice it.
    expect(failure).toMatchObject({ outcome: 'failed' })
    expect(failure!.error).toMatch(/timezone/i)

    await prisma.property.delete({ where: { id: broken.id } })
  })
})

/// The ids of this file's own events, so a dispatch touches nothing another
/// concurrently-running suite emitted. Without it these assertions depend on
/// what the rest of the suite happens to be doing at the same moment - which
/// is how "retries a consumer that failed" became a one-in-three failure.
async function mine(aggregateId: string): Promise<{ eventIds: string[] }> {
  const events = await prisma.outboxEvent.findMany({
    where: { aggregateId },
    select: { id: true },
  })
  return { eventIds: events.map((e) => e.id) }
}

describe('the event outbox', () => {
  it('delivers an event to a subscribed consumer and marks it published', async () => {
    const seen: string[] = []
    CONSUMERS.push({
      name: 'test.recorder',
      event: 'lease.ended',
      handle: async (_tx, event) => {
        seen.push(event.aggregateId)
      },
    })

    await emitEvent(prisma, {
      type: 'lease.ended',
      aggregateType: 'Lease',
      aggregateId: 'lease_1',
      propertyId: chicagoPropertyId,
    })

    const result = await dispatchOutbox(100, await mine('lease_1'))
    expect(result.published).toBeGreaterThanOrEqual(1)
    expect(seen).toEqual(['lease_1'])

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { propertyId: chicagoPropertyId },
    })
    expect(event.publishedAt).not.toBeNull()
  })

  // At-least-once delivery plus idempotent consumers. Exactly-once delivery
  // does not exist; this is what stands in for it.
  it('never delivers the same event to the same consumer twice', async () => {
    let calls = 0
    CONSUMERS.push({
      name: 'test.counter',
      event: 'lease.ended',
      handle: async () => {
        calls++
      },
    })

    await emitEvent(prisma, {
      type: 'lease.ended',
      aggregateType: 'Lease',
      aggregateId: 'lease_2',
      propertyId: chicagoPropertyId,
    })

    const only = await mine('lease_2')
    await dispatchOutbox(100, only)
    await dispatchOutbox(100, only)
    await dispatchOutbox(100, only)

    expect(calls).toBe(1)
  })

  // A consumer whose effects fail must be RETRIED, not skipped. The
  // consumption row and the effects share a transaction precisely so a
  // half-success cannot be recorded as a success.
  it('retries a consumer that failed, and does not re-run one that succeeded', async () => {
    let goodCalls = 0
    let badCalls = 0
    let failNext = true

    CONSUMERS.push({
      name: 'test.good',
      event: 'lease.activated',
      handle: async () => {
        goodCalls++
      },
    })
    CONSUMERS.push({
      name: 'test.bad',
      event: 'lease.activated',
      handle: async () => {
        badCalls++
        if (failNext) throw new Error('consumer exploded')
      },
    })

    await emitEvent(prisma, {
      type: 'lease.activated',
      aggregateType: 'Lease',
      aggregateId: 'lease_3',
      propertyId: chicagoPropertyId,
    })

    const only = await mine('lease_3')
    const first = await dispatchOutbox(100, only)
    expect(first.failed).toBeGreaterThanOrEqual(1)
    expect(goodCalls).toBe(1)
    expect(badCalls).toBe(1)

    failNext = false
    await dispatchOutbox(100, only)

    // The failing consumer got another turn...
    expect(badCalls).toBe(2)
    // ...and the one that already succeeded did not run again.
    expect(goodCalls).toBe(1)

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: 'lease_3' },
    })
    expect(event.publishedAt).not.toBeNull()
  })

  it('ignores events no consumer is subscribed to', async () => {
    await emitEvent(prisma, {
      type: 'ticket.created',
      aggregateType: 'Ticket',
      aggregateId: 'ticket_1',
      propertyId: chicagoPropertyId,
    })

    // An empty registry is a working bus, not a broken one: nothing is lost
    // while the consumers that care are still being built.
    await dispatchOutbox(100, await mine('ticket_1'))
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: 'ticket_1' },
    })
    expect(event.publishedAt).not.toBeNull()
  })

  // The whole reason emitEvent takes a transaction client.
  it('emits nothing when the transaction that emitted it rolls back', async () => {
    class Rollback extends Error {}
    await expect(
      prisma.$transaction(async (tx) => {
        await emitEvent(tx, {
          type: 'lease.ended',
          aggregateType: 'Lease',
          aggregateId: 'lease_rolled_back',
          propertyId: chicagoPropertyId,
        })
        throw new Rollback()
      }),
    ).rejects.toThrow(Rollback)

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: 'lease_rolled_back' },
      }),
    ).toBe(0)
  })
})

describe('business dates as stored', () => {
  it('stores the property-local day, not the UTC one', async () => {
    SCHEDULED_JOBS.push({
      type: 'test.date',
      localHour: 0,
      description: 'test',
      run: async () => {},
    })

    // 03:00 UTC on the 5th is still the 4th in both Chicago and Honolulu.
    const instant = new Date('2026-08-05T03:00:00Z')
    expect(businessDate(instant, CHICAGO)).toBe('2026-08-04')
    await runForTestProperties(instant)

    const runs = await prisma.jobRun.findMany({
      where: {
        jobType: 'test.date',
        propertyId: { in: [chicagoPropertyId, honoluluPropertyId] },
      },
    })
    for (const run of runs) {
      expect(run.businessDate.toISOString().slice(0, 10)).toBe('2026-08-04')
    }
  })
})

// R-174. Everything above proves a job runs once on the day it is due. These
// prove what happens on the day it did NOT run, and after the day it failed -
// which until R-174 was nothing at all, for ever, silently.
describe('missed and failed runs', () => {
  /// The date-only column, written the way the runner writes it.
  function utcDate(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`)
  }

  it('catches up a business date the cron missed', async () => {
    // Chicago ran on the 2nd and then the cron died through the 3rd. The 4th
    // is today.
    await prisma.jobRun.create({
      data: {
        jobType: 'test.catchup',
        propertyId: chicagoPropertyId,
        businessDate: utcDate('2026-08-02'),
        status: 'SUCCEEDED',
        finishedAt: new Date('2026-08-02T07:00:00Z'),
      },
    })

    const ran: string[] = []
    SCHEDULED_JOBS.push({
      type: 'test.catchup',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (context.propertyId === chicagoPropertyId) ran.push(context.businessDate)
      },
    })

    const summaries = await runForTestProperties(
      new Date('2026-08-04T07:00:00Z'),
    )

    // The 3rd first, then today. Oldest first, and both actually executed -
    // the missed day is a run, not a row backdated to look like one.
    expect(ran).toEqual(['2026-08-03', '2026-08-04'])
    const chicago = summaries.filter(
      (s) => s.propertyId === chicagoPropertyId && s.jobType === 'test.catchup',
    )
    expect(chicago.map((s) => `${s.businessDate}:${s.outcome}`)).toEqual([
      '2026-08-03:caught_up',
      '2026-08-04:ran',
    ])
  })

  // The condition that keeps the catch-up from being a backfill. A job
  // registered today, or a property acquired today, has no earlier run - so
  // there is no evidence it was ever live on those dates, and running it
  // anyway is how a fresh import gets three days of late fees on its first
  // tick.
  it('does not backfill a job that has never run at this property', async () => {
    const ran: string[] = []
    SCHEDULED_JOBS.push({
      type: 'test.fresh',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (context.propertyId === chicagoPropertyId) ran.push(context.businessDate)
      },
    })

    await runForTestProperties(new Date('2026-08-04T07:00:00Z'))
    expect(ran).toEqual(['2026-08-04'])
  })

  // A cron down longer than the bound is a person's decision, not a tick's.
  it('does not catch up a gap older than the window', async () => {
    await prisma.jobRun.create({
      data: {
        jobType: 'test.stale',
        propertyId: chicagoPropertyId,
        businessDate: utcDate('2026-07-20'),
        status: 'SUCCEEDED',
        finishedAt: new Date('2026-07-20T07:00:00Z'),
      },
    })

    const ran: string[] = []
    SCHEDULED_JOBS.push({
      type: 'test.stale',
      localHour: 2,
      description: 'test',
      run: async (context) => {
        if (context.propertyId === chicagoPropertyId) ran.push(context.businessDate)
      },
    })

    await runForTestProperties(new Date('2026-08-04T07:00:00Z'))
    expect(ran).toEqual(['2026-08-04'])
  })

  it('raises a Task when a job fails', async () => {
    SCHEDULED_JOBS.push({
      type: 'test.task_on_failure',
      localHour: 0,
      description: 'The nightly thing',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        throw new Error('boom')
      },
    })

    await runForTestProperties(new Date('2026-08-04T12:00:00Z'))

    const run = await prisma.jobRun.findFirstOrThrow({
      where: {
        jobType: 'test.task_on_failure',
        propertyId: chicagoPropertyId,
      },
    })
    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'job_failed', subjectId: run.id },
    })
    expect(task.propertyId).toBe(chicagoPropertyId)
    expect(task.subjectType).toBe('JobRun')
    expect(task.priority).toBe('URGENT')
    expect(task.title).toContain('The nightly thing')
    expect(task.title).toContain('boom')
  })

  it('re-runs a failed run in place and closes its task', async () => {
    let explode = true
    const ran: string[] = []
    SCHEDULED_JOBS.push({
      type: 'test.rerun',
      localHour: 0,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        if (explode) throw new Error('boom')
        ran.push(context.businessDate)
        return { fixed: true }
      },
    })

    await runForTestProperties(new Date('2026-08-04T12:00:00Z'))
    const failed = await prisma.jobRun.findFirstOrThrow({
      where: { jobType: 'test.rerun', propertyId: chicagoPropertyId },
    })
    expect(failed.status).toBe('FAILED')

    explode = false
    expect(await rerunJobRun(failed.id)).toEqual({ ok: true })

    const after = await prisma.jobRun.findUniqueOrThrow({
      where: { id: failed.id },
    })
    // Updated in place: the attempt count went up and the ORIGINAL startedAt
    // survived, because the evidence that it failed last night is the thing
    // the panel exists to show.
    expect(after.status).toBe('SUCCEEDED')
    expect(after.attempts).toBe(2)
    expect(after.startedAt.getTime()).toBe(failed.startedAt.getTime())
    expect(after.error).toBeNull()
    expect(after.result).toEqual({ fixed: true })
    // It ran for the date it originally failed on, not for today.
    expect(ran).toContain('2026-08-04')

    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'job_failed', subjectId: failed.id },
    })
    expect(task.status).toBe('DONE')
  })

  // The safety boundary. These jobs are idempotent per (type, property, date)
  // BECAUSE of the run row - re-running a successful one posts the charges
  // twice.
  it('refuses to re-run a run that succeeded', async () => {
    let calls = 0
    SCHEDULED_JOBS.push({
      type: 'test.no_rerun',
      localHour: 0,
      description: 'test',
      run: async (context) => {
        if (isOurs(context.propertyId)) calls++
      },
    })

    await runForTestProperties(new Date('2026-08-04T12:00:00Z'))
    const succeeded = await prisma.jobRun.findFirstOrThrow({
      where: { jobType: 'test.no_rerun', propertyId: chicagoPropertyId },
    })
    expect(succeeded.status).toBe('SUCCEEDED')

    expect(await rerunJobRun(succeeded.id)).toEqual({
      ok: false,
      reason: 'not_failed',
    })
    expect(calls).toBe(2) // the two properties' first runs, and nothing more
  })

  it('refuses to re-run a job nothing registers any more', async () => {
    SCHEDULED_JOBS.push({
      type: 'test.retired',
      localHour: 0,
      description: 'test',
      run: async (context) => {
        if (!isOurs(context.propertyId)) return
        throw new Error('boom')
      },
    })
    await runForTestProperties(new Date('2026-08-04T12:00:00Z'))
    const failed = await prisma.jobRun.findFirstOrThrow({
      where: { jobType: 'test.retired', propertyId: chicagoPropertyId },
    })

    SCHEDULED_JOBS.length = 0
    expect(await rerunJobRun(failed.id)).toEqual({
      ok: false,
      reason: 'unknown_job',
    })
    // Still FAILED, not left claimed as RUNNING by a re-run that never began.
    expect(
      (await prisma.jobRun.findUniqueOrThrow({ where: { id: failed.id } })).status,
    ).toBe('FAILED')
  })
})
