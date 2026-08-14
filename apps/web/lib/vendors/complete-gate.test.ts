import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { markWorkComplete } from './actions.ts'
import { issueVendorLink } from './link.ts'

// `revalidatePath` throws outside a request context ("static generation store
// missing"), so the SUCCESS path of any server action is untestable without
// this. Local rather than a global alias like `server-only`'s: this is the
// first test to need it, and a repo-wide stub would silence cache
// invalidation everywhere for the benefit of one file. Promote it if a third
// test wants the same thing.
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))

// MAINT-06's required completion photo, enforced (R-032b).
//
// D-17 asserted this was "already built into R-025's vendor upload" while
// justifying deferring R-028. It was not: the upload existed and nothing
// required it, so a work order could reach WORK_COMPLETE with no evidence it
// had been done — which is the state R-030 asks the tenant to confirm against
// and R-031 later charges a tenant from.
//
// The test exists because the rule is invisible from inside either function:
// `vendorMayMarkComplete` only ever knew about status, and the upload never
// knew it was mandatory.

let entityId: string
let propertyId: string
let unitId: string
let vendorId: string
const documentIds: string[] = []

beforeAll(async () => {
  const stamp = `gate-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '6 Evidence Way',
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
  const vendor = await prisma.vendor.create({
    data: { name: `Sparks-${randomUUID().slice(0, 6)}`, trades: ['ELECTRICAL'] },
  })
  vendorId = vendor.id
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedAcceptedJob() {
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      vendorId,
      scope: 'Replace the bathroom extractor',
      priority: 'ROUTINE',
      status: 'ASSIGNED',
      dispatchedAt: new Date(),
      // Accepted, so `vendorMayUpload` passes and the ONLY thing standing
      // between this vendor and WORK_COMPLETE is the photo.
      vendorResponse: 'ACCEPTED',
      vendorRespondedAt: new Date(),
    },
  })
  const { token } = await issueVendorLink(workOrder.id, vendorId)
  return { workOrder, token }
}

async function addCompletionPhoto(workOrderId: string) {
  const doc = await prisma.document.create({
    data: {
      propertyId,
      unitId,
      workOrderId,
      type: 'COMPLETION_PHOTO',
      fileName: 'done.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 3,
      storageKey: `test/${randomUUID()}.jpg`,
    },
  })
  documentIds.push(doc.id)
  return doc
}

describe('markWorkComplete', () => {
  it('REFUSES without a completion photo, and says which thing is missing', async () => {
    const { workOrder, token } = await seedAcceptedJob()

    const result = await markWorkComplete(token)

    expect(result.error).toMatch(/photo of the finished work/i)
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    // Still ASSIGNED. The refusal is not cosmetic.
    expect(after.status).toBe('ASSIGNED')
    expect(after.completedAt).toBeNull()
  }, 20_000)

  it('accepts once the photo is there', async () => {
    const { workOrder, token } = await seedAcceptedJob()
    await addCompletionPhoto(workOrder.id)

    const result = await markWorkComplete(token)

    expect(result.error).toBeUndefined()
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('WORK_COMPLETE')
    expect(after.completedAt).not.toBeNull()
  }, 20_000)

  it('does not count an INVOICE as the completion photo', async () => {
    // A napkin photo of a bill is evidence of what is owed, not evidence the
    // work happened. Half of vendors upload the invoice first, so this is the
    // near-miss the count has to get right.
    const { workOrder, token } = await seedAcceptedJob()
    const invoice = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        workOrderId: workOrder.id,
        type: 'INVOICE',
        fileName: 'napkin.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 3,
        storageKey: `test/${randomUUID()}.jpg`,
      },
    })
    documentIds.push(invoice.id)

    const result = await markWorkComplete(token)
    expect(result.error).toMatch(/photo of the finished work/i)
  }, 20_000)

  it('does not count a SOFT-DELETED photo', async () => {
    // R-012's 30-day undelete means a removed photo is still a row. Counting
    // it would let a deleted photo hold the gate open.
    const { workOrder, token } = await seedAcceptedJob()
    const photo = await addCompletionPhoto(workOrder.id)
    await prisma.document.update({
      where: { id: photo.id },
      data: { deletedAt: new Date() },
    })

    const result = await markWorkComplete(token)
    expect(result.error).toMatch(/photo of the finished work/i)
  }, 20_000)

  it('does not count a photo from somebody else’s job', async () => {
    const mine = await seedAcceptedJob()
    const theirs = await seedAcceptedJob()
    await addCompletionPhoto(theirs.workOrder.id)

    const result = await markWorkComplete(mine.token)
    expect(result.error).toMatch(/photo of the finished work/i)
  }, 20_000)
})
