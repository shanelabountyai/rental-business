import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers only this job into this file's SCHEDULED_JOBS.
import './coi-job.ts'

// MAINT-11 (R-214): expiry/lapse alerts on a vendor's certificate of insurance.

const stamp = `coijob-${Date.now()}`
// The file's own postal code, so its vendors cover its property and nobody
// else's - and a vendor limited to another code is provably out of territory.
const postalCode = `9${String(Date.now()).slice(-4)}`
let entityId: string
let propertyId: string

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: stamp,
      state: 'TX',
      postalCode,
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

// By ownership (the stamp and the property), never by a collected id list.
afterAll(async () => {
  const vendors = await prisma.vendor.findMany({ where: { name: { startsWith: stamp } }, select: { id: true } })
  await prisma.task.deleteMany({ where: { OR: [{ propertyId }, { subjectId: { in: vendors.map((v) => v.id) } }] } })
  await prisma.vendor.deleteMany({ where: { name: { startsWith: stamp } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.update({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function makeVendor(label: string, coiExpiresOn: string | null, serviceAreas = [postalCode]) {
  return prisma.vendor.create({
    data: {
      name: `${stamp} ${label}`,
      trades: ['roofing'],
      serviceAreas,
      coiExpiresOn: coiExpiresOn ? new Date(`${coiExpiresOn}T00:00:00Z`) : null,
    },
  })
}

const tasksFor = (subjectId: string) => prisma.task.findMany({ where: { subjectId } })

describe('the vendor COI check job', () => {
  // One run over all of them: the job runs once per property per local day.
  it('flags lapsed and expiring certificates in territory, and nothing else', async () => {
    const lapsed = await makeVendor('lapsed', '2026-02-01')
    const expiring = await makeVendor('expiring', '2026-08-20')
    const current = await makeVendor('current', '2027-06-01')
    const missing = await makeVendor('missing', null)
    const elsewhere = await makeVendor('elsewhere', '2026-02-01', ['00000'])

    await runDueJobs(new Date('2026-08-02T11:00:00Z'), { propertyIds: [propertyId] })

    const [lapsedTask] = await tasksFor(lapsed.id)
    expect(lapsedTask).toMatchObject({ type: 'vendor_coi_lapsed', priority: 'URGENT', subjectType: 'Vendor', propertyId })
    const [expiringTask] = await tasksFor(expiring.id)
    expect(expiringTask).toMatchObject({ type: 'vendor_coi_expiring', priority: 'ROUTINE' })
    expect(await tasksFor(current.id)).toHaveLength(0)
    // Missing cover is shown at the decision (labels, dispatch), not queued.
    expect(await tasksFor(missing.id)).toHaveLength(0)
    expect(await tasksFor(elsewhere.id)).toHaveLength(0)

    // A later day does not raise a second flag while the first is open.
    await runDueJobs(new Date('2026-08-03T11:00:00Z'), { propertyIds: [propertyId] })
    expect(await tasksFor(lapsed.id)).toHaveLength(1)
  })
})
