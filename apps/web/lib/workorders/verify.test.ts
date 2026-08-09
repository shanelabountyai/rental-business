import { randomUUID } from 'node:crypto'
import { vendorReopenRates } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closedJobCostsForProperty,
  requestVerification,
  vendorVerificationRows,
  verificationsFor,
} from './verify.ts'

// Verify & close against a real database (MAINT-07, R-030).
//
// The assertion that matters most in this file is the attribution one: a
// reopened job that gets reassigned must still count the reopen against the
// vendor whose work came back, not against whoever eventually fixed it. That
// is what MAINT-07's "captured from day one" is protecting, and it is
// unrecoverable if it is ever wrong.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let vendorAId: string
let vendorBId: string
const workOrderIds: string[] = []
const ticketIds: string[] = []

beforeAll(async () => {
  const stamp = `verify-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '3 Verify Court',
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
    data: { firstName: 'Kit', lastName: `Verify-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id

  vendorAId = (
    await prisma.vendor.create({
      data: { name: `A-${randomUUID().slice(0, 6)}`, trades: ['plumbing'] },
    })
  ).id
  vendorBId = (
    await prisma.vendor.create({
      data: { name: `B-${randomUUID().slice(0, 6)}`, trades: ['plumbing'] },
    })
  ).id
})

afterAll(async () => {
  await prisma.workOrderVerification.deleteMany({
    where: { workOrderId: { in: workOrderIds } },
  })
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipientId: tenantId } },
  })
  await prisma.task.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.vendor.deleteMany({ where: { id: { in: [vendorAId, vendorBId] } } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  // Deactivated rather than deleted: an audit row carrying this property's
  // id cannot be cascaded onto (append-only trigger), the same wall R-029's
  // escalation fixture hit.
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedJob(options: { vendorId?: string | null; withTicket?: boolean } = {}) {
  let ticketId: string | undefined
  if (options.withTicket !== false) {
    const ticket = await prisma.ticket.create({
      data: {
        propertyId,
        unitId,
        tenantId,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'The kitchen tap will not stop dripping.',
        priority: 'ROUTINE',
        status: 'CONVERTED',
      },
    })
    ticketIds.push(ticket.id)
    ticketId = ticket.id
  }

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId,
      vendorId: options.vendorId ?? null,
      scope: 'Replace the cartridge',
      status: 'WORK_COMPLETE',
      completedAt: new Date(),
    },
  })
  workOrderIds.push(workOrder.id)
  return workOrder
}

async function answer(
  workOrderId: string,
  vendorId: string | null,
  resolved: boolean,
  round = 1,
  rating: number | null = null,
) {
  return prisma.workOrderVerification.create({
    data: { workOrderId, tenantId, vendorId, round, resolved, rating },
  })
}

describe('requestVerification', () => {
  it('asks the tenant, and asks only once for the same round', async () => {
    const workOrder = await seedJob({ vendorId: vendorAId })

    await requestVerification(workOrder.id)
    await requestVerification(workOrder.id)

    const asked = await prisma.notification.count({
      where: {
        idempotencyKey: { startsWith: `workorder-verify:${workOrder.id}:1:` },
      },
    })
    // One per channel, and the second call added nothing.
    expect(asked).toBeGreaterThan(0)
    const again = await prisma.notification.count({
      where: { idempotencyKey: { startsWith: `workorder-verify:${workOrder.id}:` } },
    })
    expect(again).toBe(asked)
  })

  it('asks AGAIN once the job has been reopened', async () => {
    // The round is in the key, so a redone job gets a fresh question rather
    // than being silently deduplicated against the first one.
    const workOrder = await seedJob({ vendorId: vendorAId })
    await requestVerification(workOrder.id)
    const first = await prisma.notification.count({
      where: { idempotencyKey: { startsWith: `workorder-verify:${workOrder.id}:` } },
    })

    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { reopenCount: 1 },
    })
    await requestVerification(workOrder.id)

    const total = await prisma.notification.count({
      where: { idempotencyKey: { startsWith: `workorder-verify:${workOrder.id}:` } },
    })
    expect(total).toBeGreaterThan(first)
  })

  it('asks nobody when there is no ticket behind the job', async () => {
    // A PM-raised make-ready has no tenant whose answer would mean anything.
    const workOrder = await seedJob({ withTicket: false })
    await requestVerification(workOrder.id)

    expect(
      await prisma.notification.count({
        where: { idempotencyKey: { startsWith: `workorder-verify:${workOrder.id}:` } },
      }),
    ).toBe(0)
  })
})

describe('attribution across a reassignment', () => {
  it('counts the reopen against the vendor whose work came back, NOT the one who fixed it', async () => {
    // The single most important assertion in this file, and the reason the
    // vendor is a column on the verification row rather than a join to the
    // work order. Vendor A does the job, the tenant says it is not fixed,
    // the PM sends vendor B, and B's fix is accepted. A must carry the
    // reopen; B must carry a clean job.
    const workOrder = await seedJob({ vendorId: vendorAId })

    await answer(workOrder.id, vendorAId, false, 1)
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { vendorId: vendorBId, reopenCount: 1 },
    })
    await answer(workOrder.id, vendorBId, true, 2)

    const a = vendorReopenRates(await vendorVerificationRows(vendorAId))[0]
    const b = vendorReopenRates(await vendorVerificationRows(vendorBId))[0]

    expect(a).toMatchObject({ reopened: 1, reopenRate: 1 })
    expect(b).toMatchObject({ reopened: 0, reopenRate: 0 })

    // And the work order itself now names B, which is exactly why reading
    // the attribution off it would have been wrong.
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.vendorId).toBe(vendorBId)
  })

  it('keeps both answers, so the earlier "no" survives the later "yes"', async () => {
    const workOrder = await seedJob({ vendorId: vendorAId })
    await answer(workOrder.id, vendorAId, false, 1)
    await answer(workOrder.id, vendorBId, true, 2)

    const history = await verificationsFor(workOrder.id)
    expect(history.map((h) => h.round)).toEqual([2, 1])
    expect(history.map((h) => h.resolved)).toEqual([true, false])
  })

  it('refuses a second answer for the same round', async () => {
    // A tenant tapping twice is one answer, and the unique index is what
    // makes that true under a double-tap rather than a check-then-insert.
    const workOrder = await seedJob({ vendorId: vendorAId })
    await answer(workOrder.id, vendorAId, true, 1)
    await expect(answer(workOrder.id, vendorAId, false, 1)).rejects.toThrow()
  })
})

describe('closedJobCostsForProperty', () => {
  it('reports the invoice where there is one, and the parts where there is not', async () => {
    const invoiced = await seedJob({ vendorId: vendorAId })
    const parts = await seedJob({ vendorId: vendorAId })
    await prisma.workOrder.update({
      where: { id: invoiced.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        actualLaborCents: 12_000,
        actualMaterialsCents: 3_400,
        invoiceCents: 15_000,
      },
    })
    await prisma.workOrder.update({
      where: { id: parts.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        actualLaborCents: 8_000,
        actualMaterialsCents: 1_000,
      },
    })

    const rows = await closedJobCostsForProperty(propertyId)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(invoiced.id)?.invoiceCents).toBe(15_000)
    expect(byId.get(parts.id)?.invoiceCents).toBeNull()
  })

  it('leaves out jobs that are not closed', async () => {
    const open = await seedJob({ vendorId: vendorAId })
    const rows = await closedJobCostsForProperty(propertyId)
    expect(rows.map((row) => row.id)).not.toContain(open.id)
  })
})
