import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assignWorkOrder, dispatchToVendor } from './actions.ts'

// The approval gate against the two actions that used to walk through it
// (MAINT-04, D-298).
//
// The gate IS the status column: `PENDING_APPROVAL` is what `decideApproval`
// looks for, and nothing else records that somebody with authority still has
// to answer. `assignWorkOrder` and `dispatchToVendor` both wrote
// `status: 'ASSIGNED'` without reading it, so an over-ceiling job could be
// handed to a vendor and the owner's task left pointing at a work order that
// "is not waiting for a decision". No test combined the two before this file.

// Same three stubs, same reasoning, as chargeback-actions.test.ts: no request
// context here, and only the SESSION is faked - the RBAC decision is real.
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({
    principal: { kind: 'staff', id: session.staffId, mfaVerified: true },
  }),
}))

let entityId: string
let propertyId: string
let unitId: string
let vendorId: string

beforeAll(async () => {
  const stamp = `wo-gate-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Ceiling Stain Court',
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
  // No email and no phone: the dispatch is the status write under test, and
  // a vendor with no address keeps this file out of the notification queue.
  const vendor = await prisma.vendor.create({ data: { name: `${stamp} Roofing` } })
  vendorId = vendor.id

  const staff = await prisma.staffUser.create({
    data: { email: `wo-gate-${randomUUID()}@example.test`, name: 'Priya Owner' },
  })
  session.staffId = staff.id
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: owner.id, legalEntityId: entityId },
  })
})

afterAll(async () => {
  await prisma.staffUser.updateMany({ where: { id: session.staffId }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

type Status = NonNullable<Parameters<typeof prisma.workOrder.create>[0]['data']['status']>

async function job(status: Status, data: { vendorId?: string; dispatchedAt?: Date } = {}) {
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      scope: 'Replace the roof decking over the back bedroom',
      priority: 'ROUTINE',
      status,
      estimateCents: 400_000,
      ...data,
    },
  })
  return workOrder.id
}

function assignTo(vendor: string) {
  const data = new FormData()
  data.set('vendorId', vendor)
  return data
}

const read = (id: string) => prisma.workOrder.findUniqueOrThrow({ where: { id } })

describe('the approval gate survives assign and dispatch', () => {
  it('refuses to assign a job that is waiting for approval', async () => {
    const id = await job('PENDING_APPROVAL')

    const state = await assignWorkOrder(id, {}, assignTo(vendorId))

    expect(state.error).toMatch(/approval/i)
    const after = await read(id)
    expect(after.status).toBe('PENDING_APPROVAL')
    expect(after.vendorId).toBeNull()
  })

  it('refuses the first dispatch of a job that is waiting for approval', async () => {
    const id = await job('PENDING_APPROVAL', { vendorId })

    const state = await dispatchToVendor(id)

    expect(state.error).toMatch(/approval/i)
    const after = await read(id)
    expect(after.status).toBe('PENDING_APPROVAL')
    expect(after.dispatchedAt).toBeNull()
    expect(await prisma.authToken.count({ where: { subjectId: id } })).toBe(0)
  })

  // R-037: a dispatched vendor's own over-ceiling invoice sends the job back
  // to PENDING_APPROVAL, and they keep their link while the office decides
  // (packages/core/vendors/access.ts). A resend there is allowed - it just
  // must not answer the approval question on the owner's behalf.
  it('resends to an already-dispatched vendor without clearing the gate', async () => {
    const id = await job('PENDING_APPROVAL', { vendorId, dispatchedAt: new Date() })

    const state = await dispatchToVendor(id)

    expect(state.error).toBeUndefined()
    expect((await read(id)).status).toBe('PENDING_APPROVAL')
  })

  it('does not drag a job in progress back to ASSIGNED on a resend', async () => {
    const id = await job('IN_PROGRESS', { vendorId, dispatchedAt: new Date() })

    const state = await dispatchToVendor(id)

    expect(state.error).toBeUndefined()
    expect((await read(id)).status).toBe('IN_PROGRESS')
  })

  it('still moves an approved job to ASSIGNED on dispatch', async () => {
    const id = await job('APPROVED', { vendorId })

    await dispatchToVendor(id)

    expect((await read(id)).status).toBe('ASSIGNED')
  })

  it.each(['CLOSED', 'CANCELED'] as const)(
    'refuses to assign a %s job rather than reopening it',
    async (status) => {
      const id = await job(status)

      const state = await assignWorkOrder(id, {}, assignTo(vendorId))

      expect(state.error).toBeTruthy()
      expect((await read(id)).status).toBe(status)
    },
  )
})
