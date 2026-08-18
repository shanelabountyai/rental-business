import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Document generation from a template (DOC-04, R-062).
//
// Pure logic (merge-field validation, block building) is proved directly in
// packages/core/documents/template.test.ts; DB reads in
// apps/web/lib/documents/template-queries.test.ts. saveDocumentTemplate,
// retireDocumentTemplate and generateDocumentFromTemplate are all
// session-dependent (requirePermission/audit()) and covered only here, the
// same wall every other staff-actions.ts in this repo draws.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const templateIds: string[] = []

async function createStaff() {
  // NOT MFA-enrolled - `template.write`/`document.write` are not privileged
  // permissions (unlike `screening.decide`/`fee.waive`), so a plain
  // password sign-in is the real, correct fixture here.
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `doctemplate-${unique}@example.test`,
      name: `Template Author ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedProperty() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Doctemplate LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Doctemplate House-${unique}`,
      addressLine1: '9 Estoppel Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { entity, property }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

// Login is rate-limited per IP (R-003) - the same distinct-address guard
// every sign-in-heavy spec carries.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.documentTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a saved template rejects an unknown merge field, names it, and a valid one saves', async ({
  page,
}) => {
  const staff = await createStaff()
  // Unique per run - browser projects (mobile/desktop) run this same test
  // concurrently, and a literal name would race between them.
  const name = `Estoppel certificate ${randomUUID().slice(0, 8)}`
  await signIn(page, staff.email)

  await page.goto('/documents/templates/new')
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Generates a').selectOption('ESTOPPEL_CERTIFICATE')
  await page.getByLabel('Body').fill('Dear {{recipient.nmae}}, this confirms the lease.')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByText(/Not a merge field: \{\{recipient.nmae\}\}/)).toBeVisible()

  const before = await prisma.documentTemplate.count({ where: { name } })
  expect(before).toBe(0)

  // React resets EVERY uncontrolled field after a form action completes,
  // success or failure - not just the one this test cares about. All three
  // fields need refilling, the same lesson e2e/screening.spec.ts already
  // hit for its own decision select.
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Generates a').selectOption('ESTOPPEL_CERTIFICATE')
  await page.getByLabel('Body').fill(
    'Dear {{recipient.name}}, this confirms {{property.name}} at {{property.address}} is owned by {{entity.name}}. Generated {{today}} by {{staff.name}}.',
  )
  await page.getByRole('button', { name: 'Save' }).click()
  // Excludes "new" itself - that path also matches [a-z0-9]+$ and would
  // resolve instantly without ever waiting for the real redirect
  // (CLAUDE.md's own documented trap, hit here for real).
  await page.waitForURL(/\/documents\/templates\/(?!new$)[a-z0-9]+$/)

  const saved = await prisma.documentTemplate.findFirstOrThrow({ where: { name } })
  templateIds.push(saved.id)
  expect(saved.documentType).toBe('ESTOPPEL_CERTIFICATE')
})

test('generating a document renders every merge field and archives an accessible PDF', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property } = await seedProperty()
  const template = await prisma.documentTemplate.create({
    data: {
      name: `Letter-${randomUUID().slice(0, 6)}`,
      documentType: 'LETTER',
      body: 'Dear {{recipient.name}}, {{property.name}} at {{property.address}} is owned by {{entity.name}}. Generated {{today}} by {{staff.name}}.',
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(template.id)

  await signIn(page, staff.email)
  await page.goto(`/documents/templates/${template.id}`)

  // "Property *", exact - the field is required (SelectField appends " *"
  // to a required label, tasks.spec.ts's own precedent for the identical
  // collision), and a bare "Property" substring-matches the admin shell's
  // own "Filter by property or entity" combobox too.
  await page.getByLabel('Property *', { exact: true }).selectOption(property.id)
  await page.getByLabel('Recipient name').fill('Jordan Blake')
  await page.getByRole('button', { name: 'Generate' }).click()

  await expect(page.getByText('Generated and archived.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download the generated PDF' })).toBeVisible()

  const document = await prisma.document.findFirstOrThrow({
    where: { propertyId: property.id, type: 'LETTER' },
  })
  expect(document.contentType).toBe('application/pdf')
  expect(document.sizeBytes).toBeGreaterThan(0)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'document.generated', entityId: document.id },
  })
  expect(audited?.after).toMatchObject({ recipientName: 'Jordan Blake', templateId: template.id })
  // Every merge field actually resolved - the owning entity's real name,
  // not a leftover token.
  expect(audited?.propertyId).toBe(property.id)
})

test('retiring a template hides its generate form', async ({ page }) => {
  const staff = await createStaff()
  const template = await prisma.documentTemplate.create({
    data: {
      name: `Retire me-${randomUUID().slice(0, 6)}`,
      documentType: 'LETTER',
      body: 'Dear {{recipient.name}},',
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(template.id)

  await signIn(page, staff.email)
  await page.goto(`/documents/templates/${template.id}`)
  await expect(page.getByRole('heading', { name: 'Generate' })).toBeVisible()

  await page.getByRole('button', { name: 'Retire' }).click()
  await expect(page.getByText('· retired')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Generate' })).toHaveCount(0)

  const updated = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: template.id } })
  expect(updated.active).toBe(false)
})
