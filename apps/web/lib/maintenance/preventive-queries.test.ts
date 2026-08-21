import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { dueCountForTemplate, dueUnitsForTemplate } from './preventive-queries.ts'

// "Every unit in scope that is due" (MAINT-08, R-080) - read live off the
// last CLOSED work order tagged with the template, not a second
// schedule-tracking table.

let entityId: string
let propertyId: string
let unitId: string
let staffId: string
let templateId: string
const workOrderIds: string[] = []

function scopeFor(ids: string[]): ResolvedScope {
  return { selection: { kind: 'all' }, availableEntities: [], availableProperties: [], propertyIds: ids, switchable: false }
}

beforeAll(async () => {
  const stamp = `pmtemplate-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' } })
  unitId = unit.id
  const staff = await prisma.staffUser.create({ data: { email: `${stamp}@example.test`, name: 'PM Test' } })
  staffId = staff.id
  const template = await prisma.preventiveMaintenanceTemplate.create({
    data: { name: `HVAC filter-${stamp}`, intervalMonths: 6, createdByStaffId: staffId },
  })
  templateId = template.id
})

afterEach(async () => {
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  workOrderIds.length = 0
})

afterAll(async () => {
  await prisma.preventiveMaintenanceTemplate.updateMany({ where: { id: templateId }, data: { active: false } })
  await prisma.unit.updateMany({ where: { id: unitId }, data: { status: 'VACANT' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function closedJob(closedAt: string) {
  const workOrder = await prisma.workOrder.create({
    data: { propertyId, unitId, scope: 'Test job', status: 'CLOSED', pmTemplateId: templateId, closedAt: new Date(closedAt) },
  })
  workOrderIds.push(workOrder.id)
  return workOrder
}

describe('dueCountForTemplate / dueUnitsForTemplate', () => {
  it('a unit never fulfilled is due now', async () => {
    const count = await dueCountForTemplate(templateId, { intervalMonths: 6 }, scopeFor([propertyId]))
    expect(count).toBe(1)
  })

  it('a unit closed recently, within the interval, is not due', async () => {
    await closedJob(new Date().toISOString())
    const count = await dueCountForTemplate(templateId, { intervalMonths: 6 }, scopeFor([propertyId]))
    expect(count).toBe(0)
  })

  it('a unit closed past the interval is due again', async () => {
    await closedJob('2020-01-01T12:00:00Z')
    const due = await dueUnitsForTemplate(templateId, { intervalMonths: 6 }, scopeFor([propertyId]))
    expect(due.map((u) => u.unitId)).toEqual([unitId])
  })

  it('a property outside scope contributes nothing', async () => {
    const count = await dueCountForTemplate(templateId, { intervalMonths: 6 }, scopeFor([]))
    expect(count).toBe(0)
  })
})
