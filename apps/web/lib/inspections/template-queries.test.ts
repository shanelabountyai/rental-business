import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getInspectionTemplate, listInspectionTemplates } from './template-queries.ts'

// Reads for InspectionTemplate (INSP-01, R-068) - the writes
// (saveInspectionTemplate/retireInspectionTemplate) are session-dependent
// via requirePermission/audit() and are e2e-only, the same wall
// documents/template-queries.test.ts's own header already draws.

const staffIds: string[] = []
const templateIds: string[] = []

beforeAll(async () => {
  const stamp = `insptemplate-${randomUUID().slice(0, 8)}`
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Checklist Author' },
  })
  staffIds.push(staff.id)

  const active = await prisma.inspectionTemplate.create({
    data: {
      name: `${stamp}-active`,
      items: [{ room: 'Kitchen', item: 'Sink' }],
      createdByStaffId: staff.id,
    },
  })
  const retired = await prisma.inspectionTemplate.create({
    data: {
      name: `${stamp}-retired`,
      items: [{ room: 'Bath', item: 'Tub' }],
      active: false,
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(active.id, retired.id)
})

afterAll(async () => {
  await prisma.inspectionTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

describe('listInspectionTemplates', () => {
  it('lists both active and retired checklists, active first', async () => {
    const templates = await listInspectionTemplates()
    const ours = templates.filter((t) => templateIds.includes(t.id))
    expect(ours).toHaveLength(2)
    expect(ours[0]?.active).toBe(true)
    expect(ours[1]?.active).toBe(false)
  })
})

describe('getInspectionTemplate', () => {
  it('returns a checklist by id, items intact', async () => {
    const template = await getInspectionTemplate(templateIds[0]!)
    expect(template?.items).toEqual([{ room: 'Kitchen', item: 'Sink' }])
  })

  it('returns null for an id that does not exist', async () => {
    expect(await getInspectionTemplate('not-a-real-id')).toBeNull()
  })
})
