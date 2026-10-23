import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { replyTaskAssignee } from './messaging-settings.ts'

// R-266: the default reply assignee is used only where they can work the
// property's tasks. The singleton is shared with every other file, so the
// assignee here holds a grant on THIS file's property only: any other file's
// reply Task still resolves to nobody, and the previous value is put back.

let previous: { replyTaskAssigneeStaffId: string | null } | null
const staffIds: string[] = []
const propertyIds: string[] = []
let covered: { id: string; legalEntityId: string; orgId: string }
let uncovered: { id: string; legalEntityId: string; orgId: string }

async function setAssignee(staffUserId: string | null) {
  await prisma.messagingSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', replyTaskAssigneeStaffId: staffUserId },
    update: { replyTaskAssigneeStaffId: staffUserId },
  })
}

async function staff(roleKey: string, propertyId: string) {
  const person = await prisma.staffUser.create({
    data: { email: `assignee-${randomUUID()}@example.test`, name: 'Reply Assignee' },
  })
  staffIds.push(person.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({ data: { staffUserId: person.id, roleId: role.id, propertyId } })
  return person.id
}

beforeAll(async () => {
  previous = await prisma.messagingSettings.findUnique({
    where: { id: 'default' },
    select: { replyTaskAssigneeStaffId: true },
  })
  const entity = await prisma.legalEntity.create({ data: { name: `assignee-${Date.now()}`, type: 'LLC' } })
  for (const name of ['covered', 'uncovered']) {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `assignee-${name}-${Date.now()}`,
        addressLine1: '1 Reply Way',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
      select: { id: true, legalEntityId: true, orgId: true },
    })
    propertyIds.push(property.id)
    if (name === 'covered') covered = property
    else uncovered = property
  }
})

afterAll(async () => {
  await setAssignee(previous?.replyTaskAssigneeStaffId ?? null)
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

describe('replyTaskAssignee', () => {
  it('names the assignee only on a property their task.write grant covers', async () => {
    const manager = await staff('manager', covered.id)
    await setAssignee(manager)
    expect(await replyTaskAssignee(covered)).toBe(manager)
    expect(await replyTaskAssignee(uncovered)).toBeNull()
  })

  it('names nobody once the assignee is deactivated', async () => {
    const manager = await staff('manager', covered.id)
    await setAssignee(manager)
    await prisma.staffUser.update({ where: { id: manager }, data: { active: false } })
    expect(await replyTaskAssignee(covered)).toBeNull()
  })

  it('names nobody whose role cannot work tasks', async () => {
    await setAssignee(await staff('read_only', covered.id))
    expect(await replyTaskAssignee(covered)).toBeNull()
  })
})
