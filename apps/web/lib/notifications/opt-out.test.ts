import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isOptedOut, recordOptIn, recordOptOut } from '../comms/opt-out-store.ts'
import { notify } from './send.ts'

// A carrier STOP, and the notice it blocks (R-040e, D-38).
//
// The defect this closes is not "a tenant texting STOP opens a ticket called
// STOP" - that is the embarrassing half. It is that `entry_notice` is in
// LOCKED_CATEGORIES *because it is legally significant*, the product refuses
// to let a tenant switch it off, and a carrier-level STOP switched it off
// anyway while our own log went on recording SENT. In a Texas entry dispute
// that log is the evidence, and a delivery record that can be silently false
// is the worst defect an evidence trail can have.

// A number no other fixture in this run holds. The e2e suite has its own
// `uniquePhone`, deliberately not imported here: a unit test reaching into
// e2e/ couples two suites that are excluded from each other's runs.
let phoneCounter = 0
function uniquePhone(): string {
  phoneCounter += 1
  const suffix = String(Date.now() % 100000).padStart(5, '0')
  return `+1512${suffix}${String(phoneCounter).padStart(2, '0')}`
}

let propertyId: string
let entityId: string
let unitId: string
let tenantId: string
const phones: string[] = []
const notificationIds: string[] = []
const taskIds: string[] = []

beforeAll(async () => {
  const stamp = `optout-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: stamp,
      addressLine1: '4 Blocked Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Opt', lastName: `Out-${randomUUID().slice(0, 6)}`, phone: uniquePhone() },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.smsOptOut.deleteMany({ where: { phone: { in: phones } } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

function tenantRecipient(phone: string) {
  return { type: 'TENANT' as const, id: tenantId, phone, email: null }
}

describe('the opt-out store', () => {
  it('blocks and unblocks a number, and is idempotent about it', async () => {
    const phone = uniquePhone()
    phones.push(phone)

    expect(await isOptedOut(phone)).toBe(false)

    const first = await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })
    expect(first.recorded).toBe(true)
    expect(await isOptedOut(phone)).toBe(true)

    // Both sources can report the same block - the tenant texts STOP and the
    // carrier also fails the next send with 21610.
    const second = await recordOptOut({ phone, source: 'CARRIER_CALLBACK', reason: '21610' })
    expect(second.recorded).toBe(false)

    // And the date it STARTED is not moved by the second report; it is the
    // fact somebody will later be accounting for.
    const row = await prisma.smsOptOut.findUniqueOrThrow({ where: { phone } })
    expect(row.optedOutAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(row.reason).toBe('STOP')

    expect((await recordOptIn({ phone, reason: 'START' })).recorded).toBe(true)
    expect(await isOptedOut(phone)).toBe(false)
  })

  it('matches however the number was typed', async () => {
    // The failure this pins: an opt-out recorded from the carrier as E.164
    // and looked up against a number a staff member typed with brackets is an
    // opt-out that does nothing at all.
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const digits = phone.replace(/^\+1/, '')
    const pretty = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    expect(await isOptedOut(pretty)).toBe(true)
  })

  it('says a number we cannot parse is not opted out, rather than throwing', async () => {
    // A send path is the wrong place to discover a malformed phone column.
    expect(await isOptedOut('not a phone')).toBe(false)
    expect(await isOptedOut(null)).toBe(false)
  })
})

describe('sending to a blocked number', () => {
  it('records the SMS as SUPPRESSED / sms_opt_out, NOT as sent', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const key = `test:entry-blocked:${randomUUID()}`
    await notify({
      category: 'entry_notice',
      templateKey: 'entry.notice',
      recipient: tenantRecipient(phone),
      context: {
        propertyName: 'Blocked House',
        unitName: 'A',
        scheduledStart: '2026-08-20T15:00:00Z',
        scheduledEnd: '2026-08-20T17:00:00Z',
        timezone: 'America/Chicago',
        reason: 'Annual inspection',
      },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-18T15:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(...rows.map((r) => r.id))

    const sms = rows.find((r) => r.channel === 'SMS')
    expect(sms).toBeDefined()
    // THE ASSERTION THE WHOLE ITEM IS FOR.
    expect(sms?.delivery?.status).toBe('SUPPRESSED')
    expect(sms?.delivery?.suppressedReason).toBe('sms_opt_out')

    // NOT `preference_off`: a tenant cannot set a preference against
    // entry_notice at all, so recording it that way would describe a choice
    // the product does not offer and would hide that we owe them a notice.
    expect(sms?.delivery?.suppressedReason).not.toBe('preference_off')
  })

  it('still sends the notice on every OTHER channel', async () => {
    // D-38's fallback half, which `entry.notice` already provided by
    // declaring three channels. Asserted so a later edit to the template
    // cannot quietly remove the only channels a blocked tenant still has.
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const key = `test:entry-fallback:${randomUUID()}`
    await notify({
      category: 'entry_notice',
      templateKey: 'entry.notice',
      recipient: { type: 'TENANT', id: tenantId, phone, email: 'blocked@example.test' },
      context: {
        propertyName: 'Blocked House',
        unitName: 'A',
        scheduledStart: '2026-08-20T15:00:00Z',
        scheduledEnd: '2026-08-20T17:00:00Z',
        timezone: 'America/Chicago',
        reason: 'Annual inspection',
      },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-18T15:00:00Z'),
    })

    const rows = await prisma.notification.findMany({
      where: { idempotencyKey: { startsWith: key } },
      include: { delivery: true },
    })
    notificationIds.push(...rows.map((r) => r.id))

    const email = rows.find((r) => r.channel === 'EMAIL')
    const portal = rows.find((r) => r.channel === 'PORTAL')
    expect(email?.delivery?.status).not.toBe('SUPPRESSED')
    expect(portal?.delivery?.status).not.toBe('SUPPRESSED')
  })

  it('RAISES A TASK for a human to serve the notice another way (D-38)', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const key = `test:entry-task:${randomUUID()}`
    await notify({
      category: 'entry_notice',
      templateKey: 'entry.notice',
      recipient: tenantRecipient(phone),
      context: {
        propertyName: 'Blocked House',
        unitName: 'A',
        scheduledStart: '2026-08-20T15:00:00Z',
        scheduledEnd: '2026-08-20T17:00:00Z',
        timezone: 'America/Chicago',
        reason: 'Annual inspection',
      },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-18T15:00:00Z'),
    })

    const task = await prisma.task.findFirst({
      where: { propertyId, type: 'serve_notice_offline', subjectId: key },
    })
    expect(task).not.toBeNull()
    taskIds.push(task!.id)
    // URGENT: this product's Priority vocabulary is EMERGENCY / URGENT /
    // ROUTINE, and EMERGENCY is reserved for life-safety. The first draft of
    // this asserted 'HIGH', which does not exist - the same mistake made once
    // before on another item, and the reason `TaskInput.priority` is now the
    // enum rather than `string` (R-040e).
    expect(task!.priority).toBe('URGENT')
    expect(task!.title).toMatch(/blocking our texts/i)
  })

  it('does NOT raise a task when the blocked category is one a tenant may switch off', async () => {
    // The distinction D-38 turns on. A blocked marketing text is a tenant
    // getting exactly what they asked for; there is no obligation to chase.
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const key = `test:unlocked:${randomUUID()}`
    await notify({
      category: 'unit_make_ready',
      templateKey: 'unit.make_ready',
      recipient: tenantRecipient(phone),
      context: { propertyName: 'Blocked House', unitName: 'A' },
      propertyId,
      idempotencyKey: key,
      now: new Date('2026-08-18T15:00:00Z'),
    })

    const task = await prisma.task.findFirst({
      where: { propertyId, type: 'serve_notice_offline', subjectId: key },
    })
    expect(task).toBeNull()
  })
})
