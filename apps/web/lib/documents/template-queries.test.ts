import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDocumentTemplate, listDocumentTemplates } from './template-queries.ts'

// Reads for DocumentTemplate (DOC-04, R-062) - the writes
// (saveDocumentTemplate/retireDocumentTemplate/generateDocumentFromTemplate)
// are session-dependent via requirePermission/audit() and are e2e-only, the
// same wall every other staff-actions.ts in this repo draws.

const staffIds: string[] = []
const templateIds: string[] = []
let otherOrgId = ''
let otherTemplateId = ''

beforeAll(async () => {
  const stamp = `doctemplate-${randomUUID().slice(0, 8)}`
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Template Author' },
  })
  staffIds.push(staff.id)

  const active = await prisma.documentTemplate.create({
    data: {
      name: `${stamp}-active`,
      documentType: 'LETTER',
      body: 'Dear {{recipient.name}},',
      createdByStaffId: staff.id,
    },
  })
  const retired = await prisma.documentTemplate.create({
    data: {
      name: `${stamp}-retired`,
      documentType: 'ESTOPPEL_CERTIFICATE',
      body: 'To whom it may concern,',
      active: false,
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(active.id, retired.id)

  // R-285b: a template in a second organisation, which org #0 must not see.
  const other = await prisma.organization.create({ data: { slug: stamp, name: `${stamp} Org` } })
  otherOrgId = other.id
  otherTemplateId = (
    await prisma.documentTemplate.create({
      data: { orgId: other.id, name: `${stamp}-other-org`, documentType: 'LETTER', body: 'Hi', createdByStaffId: staff.id },
    })
  ).id
})

afterAll(async () => {
  await prisma.documentTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.documentTemplate.deleteMany({ where: { orgId: otherOrgId } })
  await prisma.organization.deleteMany({ where: { id: otherOrgId } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

describe('listDocumentTemplates', () => {
  it('lists both active and retired templates, active first', async () => {
    const templates = await listDocumentTemplates('org_0')
    const ours = templates.filter((t) => templateIds.includes(t.id))
    expect(ours).toHaveLength(2)
    expect(ours[0]?.active).toBe(true)
    expect(ours[1]?.active).toBe(false)
  })
})

describe('organisation bound (R-285b, PRD 10 §M3)', () => {
  it("neither lists nor opens another org's template", async () => {
    expect((await listDocumentTemplates('org_0')).map((t) => t.id)).not.toContain(otherTemplateId)
    expect(await getDocumentTemplate(otherTemplateId, 'org_0')).toBeNull()
    expect((await listDocumentTemplates(otherOrgId)).map((t) => t.id)).toEqual([otherTemplateId])
    expect((await getDocumentTemplate(otherTemplateId, otherOrgId))?.id).toBe(otherTemplateId)
  })
})

describe('getDocumentTemplate', () => {
  it('returns a template by id', async () => {
    const template = await getDocumentTemplate(templateIds[0]!, 'org_0')
    expect(template?.documentType).toBe('LETTER')
  })

  it('returns null for an id that does not exist', async () => {
    expect(await getDocumentTemplate('not-a-real-id', 'org_0')).toBeNull()
  })
})
