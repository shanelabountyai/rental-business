import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { onCallStaffForProperty, shutoffForEmergency } from './emergency.ts'

// The two database-backed halves of R-020: finding the RIGHT shutoff for an
// emergency (PROP-03/R-014's unit record), and finding everyone who should be
// woken up (MAINT-01's "paged immediately regardless of hour").

let entityId: string
let propertyId: string
let unitId: string
const staffIds: string[] = []
const documentIds: string[] = []

beforeAll(async () => {
  const stamp = `emergency-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Emergency Way',
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

  await prisma.shutoffLocation.createMany({
    data: [
      {
        unitId,
        type: 'WATER_MAIN',
        description: 'Left side of the house, under the hose bib.',
      },
      {
        unitId,
        type: 'BREAKER_PANEL',
        description: 'Hallway closet, behind the coats.',
      },
      { unitId, type: 'GAS', description: 'At the meter, street side.' },
    ],
  })
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.shutoffLocation.deleteMany({ where: { unitId } })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.deleteMany({ where: { id: propertyId } })
  await prisma.legalEntity.deleteMany({ where: { id: entityId } })
  await prisma.$disconnect()
})

async function makeStaff(roleKey: string, scope: { propertyId?: string; legalEntityId?: string } = {}) {
  const staff = await prisma.staffUser.create({
    data: {
      email: `emergency-${randomUUID()}@example.test`,
      name: 'Emergency Test',
      phone: '+15125550100',
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      propertyId: scope.propertyId,
      legalEntityId: scope.legalEntityId,
    },
  })
  return staff
}

describe('shutoffForEmergency', () => {
  it('returns the water main for flooding', async () => {
    const shutoff = await shutoffForEmergency(unitId, 'ACTIVE_FLOODING')
    expect(shutoff?.type).toBe('WATER_MAIN')
    expect(shutoff?.description).toContain('hose bib')
  })

  it('returns the breaker panel for an electrical burning smell', async () => {
    const shutoff = await shutoffForEmergency(unitId, 'ELECTRICAL_BURNING')
    expect(shutoff?.type).toBe('BREAKER_PANEL')
    expect(shutoff?.description).toContain('Hallway closet')
  })

  it('returns NOTHING for a gas smell, even though a gas shutoff is on file', async () => {
    // The most important assertion in this file. The unit record HAS a gas
    // shutoff recorded, and this still returns null - because the right
    // action for somebody who can smell gas is to leave, not to go hunting
    // for a valve with a phone torch.
    expect(await shutoffForEmergency(unitId, 'GAS_SMELL')).toBeNull()
  })

  it('returns nothing for a CO alarm', async () => {
    expect(await shutoffForEmergency(unitId, 'CO_ALARM')).toBeNull()
  })

  it('returns null when the unit has no shutoff of that type recorded', async () => {
    const bareUnit = await prisma.unit.create({
      data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
    })
    expect(await shutoffForEmergency(bareUnit.id, 'ACTIVE_FLOODING')).toBeNull()
    await prisma.unit.delete({ where: { id: bareUnit.id } })
  })

  it('includes the newest shutoff photo when one exists', async () => {
    const older = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        type: 'SHUTOFF_PHOTO',
        fileName: 'old.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        createdAt: new Date('2026-01-01'),
      },
    })
    documentIds.push(older.id)
    const newer = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        type: 'SHUTOFF_PHOTO',
        fileName: 'new.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        createdAt: new Date('2026-06-01'),
      },
    })
    documentIds.push(newer.id)

    const shutoff = await shutoffForEmergency(unitId, 'ACTIVE_FLOODING')
    // A re-photographed shutoff supersedes the old one.
    expect(shutoff?.photoDocumentId).toBe(newer.id)
  })
})

describe('onCallStaffForProperty', () => {
  it('includes a portfolio-wide, an entity-scoped, and a property-scoped holder of ticket.write', async () => {
    const portfolio = await makeStaff('owner')
    const entityScoped = await makeStaff('manager', { legalEntityId: entityId })
    const propertyScoped = await makeStaff('manager', { propertyId })

    const paged = (await onCallStaffForProperty(propertyId)).map((s) => s.id)
    expect(paged).toContain(portfolio.id)
    expect(paged).toContain(entityScoped.id)
    expect(paged).toContain(propertyScoped.id)
  })

  it('excludes staff scoped to a DIFFERENT property', async () => {
    const otherProperty = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `other-${randomUUID().slice(0, 6)}`,
        addressLine1: '1 Elsewhere',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    const elsewhere = await makeStaff('manager', { propertyId: otherProperty.id })

    const paged = (await onCallStaffForProperty(propertyId)).map((s) => s.id)
    expect(paged).not.toContain(elsewhere.id)

    await prisma.staffAssignment.deleteMany({ where: { staffUserId: elsewhere.id } })
    await prisma.property.delete({ where: { id: otherProperty.id } })
  })

  it('excludes a role without ticket.write', async () => {
    // read_only holds ticket.read but not ticket.write - somebody who cannot
    // act on a ticket should not be woken up about one.
    const readOnly = await makeStaff('read_only', { propertyId })
    const paged = (await onCallStaffForProperty(propertyId)).map((s) => s.id)
    expect(paged).not.toContain(readOnly.id)
  })

  it('excludes a deactivated staff member', async () => {
    // ROLE-06's revocation has to reach the pager too - a departed employee
    // being woken up for an emergency is both useless and a disclosure.
    const departed = await makeStaff('manager', { propertyId })
    await prisma.staffUser.update({
      where: { id: departed.id },
      data: { active: false },
    })
    const paged = (await onCallStaffForProperty(propertyId)).map((s) => s.id)
    expect(paged).not.toContain(departed.id)
  })

  it('pages somebody exactly once however many grants reach them', async () => {
    const both = await makeStaff('manager', { legalEntityId: entityId })
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
    await prisma.staffAssignment.create({
      data: { staffUserId: both.id, roleId: role.id, propertyId },
    })

    const paged = (await onCallStaffForProperty(propertyId)).filter(
      (s) => s.id === both.id,
    )
    expect(paged).toHaveLength(1)
  })

  it('carries the phone number, since the SMS page is the point', async () => {
    const staff = await makeStaff('manager', { propertyId })
    const paged = await onCallStaffForProperty(propertyId)
    const found = paged.find((s) => s.id === staff.id)
    expect(found?.phone).toBe('+15125550100')
    expect(found?.email).toContain('@example.test')
  })
})
