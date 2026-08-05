import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import {
  createTotpEnrolment,
  hashPassword,
  mintRecoveryCodes,
  sealSecret,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Document attach/find/version/soft-delete (DOC-01, DOC-05, PROP-08, R-012).
// Only Property and Unit are real attachment targets today - Lease, Tenant,
// Vendor, Ticket and WorkOrder all have a column on Document already (R-002)
// but no CRUD of their own yet to attach to for real.
//
// 'document.delete' is PRIVILEGED (packages/core/rbac/permissions.ts) and
// therefore MFA-gated (ROLE-05) - the first permission this session's e2e
// suite has exercised through the UI that actually requires it. Deleting and
// restoring needs an MFA-enrolled, MFA-verified sign-in; every other action
// here (upload, read) does not.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const documentIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `documents-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Documents Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      propertyId: scope?.propertyId,
      legalEntityId: scope?.legalEntityId,
    },
  })
  return { ...staff, password: PASSWORD }
}

async function seedProperty(name = 'Seed House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `Seed LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${name}-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
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

async function seedUnit(propertyId: string) {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `Unit-${randomUUID().slice(0, 8)}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  return unit
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...auditedStaff] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

/// An owner enrolled in MFA and signed in through the full challenge -
/// mfaVerified only becomes true this way, and 'document.delete' will not
/// clear can()'s check without it. Mirrors e2e/auth.spec.ts's
/// createEnrolledStaff/submitPassword pattern.
async function createMfaVerifiedOwner(page: import('@playwright/test').Page) {
  const staff = await createStaff('owner')
  const { secret } = createTotpEnrolment(staff.email)
  const recovery = mintRecoveryCodes(3)
  await prisma.staffCredential.update({
    where: { staffUserId: staff.id },
    data: {
      mfaSecret: sealSecret(secret),
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: recovery.hashes,
    },
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate()
  await page.getByLabel(/code/i).fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
  return staff
}

test.describe('uploading and downloading', () => {
  test('uploads a document on a property and downloads it back byte-for-byte', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    // Not getByLabel('Type') - R-015's filing cabinet added a "Rate type"
    // field (Mortgage form) to this same property page, and getByLabel does
    // a substring match by default ("Rate type" contains "type");
    // #field-doc-type is the upload form's select alone.
    await page.locator('#field-doc-type').selectOption('INSURANCE_COI')
    await page
      .getByLabel('File')
      .setInputFiles({ name: 'coi.txt', mimeType: 'text/plain', buffer: Buffer.from('proof of insurance') })
    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('coi.txt')).toBeVisible()

    const created = await prisma.document.findFirstOrThrow({
      where: { propertyId: property.id, fileName: 'coi.txt' },
    })
    documentIds.push(created.id)
    expect(created.type).toBe('INSURANCE_COI')
    expect(created.sizeBytes).toBe(Buffer.from('proof of insurance').byteLength)

    const download = await page.request.get(`/api/documents/${created.id}/file`)
    expect(download.ok()).toBe(true)
    expect(await download.text()).toBe('proof of insurance')
    expect(download.headers()['content-type']).toBe('text/plain')
  })

  test('uploads a photo to a unit’s photo library (PROP-08)', async ({ page }) => {
    const { property } = await seedProperty()
    const unit = await seedUnit(property.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    // Not getByLabel('Type') - the unit page also carries the operational-
    // data section's own "Type" fields (access code, shutoff), all sharing
    // that accessible name by design; #field-doc-type is this form's alone.
    await page.locator('#field-doc-type').selectOption('UNIT_PHOTO')
    // exact: true - a substring match on "File" also catches "Landlord-
    // revert agreement on file" from the operational-data section elsewhere
    // on this same unit page.
    await page
      .getByLabel('File', { exact: true })
      .setInputFiles({ name: 'kitchen.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff]) })
    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('kitchen.jpg')).toBeVisible()

    const created = await prisma.document.findFirstOrThrow({
      where: { unitId: unit.id, fileName: 'kitchen.jpg' },
    })
    documentIds.push(created.id)
    expect(created.propertyId).toBe(property.id)

    // Does not appear on the property-level list - a unit photo lives in the
    // unit's own section, not mixed into the property's general documents.
    await page.goto(`/properties/${property.id}`)
    await expect(page.getByText('kitchen.jpg')).toHaveCount(0)
  })

  test('refuses an unauthenticated download', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/properties/${property.id}`)
    await page.locator('#field-doc-type').selectOption('OTHER')
    await page
      .getByLabel('File')
      .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('note.txt')).toBeVisible()
    const created = await prisma.document.findFirstOrThrow({
      where: { propertyId: property.id, fileName: 'note.txt' },
    })
    documentIds.push(created.id)

    const anonymous = await page.request.get(`/api/documents/${created.id}/file`, {
      headers: { cookie: '' },
      maxRedirects: 0,
    })
    expect([302, 307]).toContain(anonymous.status())
  })
})

test.describe('soft delete and restore', () => {
  test('deletes with a reason, then restores', async ({ page }) => {
    const { property } = await seedProperty()
    await createMfaVerifiedOwner(page)

    await page.goto(`/properties/${property.id}`)
    await page.locator('#field-doc-type').selectOption('OTHER')
    await page
      .getByLabel('File')
      .setInputFiles({ name: 'scratch.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('scratch.txt')).toBeVisible()

    const created = await prisma.document.findFirstOrThrow({
      where: { propertyId: property.id, fileName: 'scratch.txt' },
    })
    documentIds.push(created.id)

    await page.getByLabel('Reason for deleting').selectOption('duplicate')
    await page.getByRole('button', { name: 'Delete' }).click()
    // Moves to the (closed) "Recently deleted" details, not out of the DOM -
    // it is still there, just not rendered while collapsed.
    await expect(page.getByText('scratch.txt')).not.toBeVisible()

    const deletedRow = await prisma.document.findUniqueOrThrow({ where: { id: created.id } })
    expect(deletedRow.deletedAt).not.toBeNull()

    const auditEntry = await prisma.auditLog.findFirst({
      where: { entityType: 'Document', entityId: created.id, action: 'document.delete_marked' },
    })
    expect(auditEntry?.reasonCode).toBe('duplicate')

    await page.getByText('Recently deleted', { exact: false }).click()
    // React ships a placeholder `action="javascript:throw ..."` on a
    // Server-Action form until hydration attaches the real handler -
    // confirmed by inspecting the DOM mid-race. The delete action's
    // redirect() swaps in a freshly server-rendered DocumentsSection, so the
    // "Recently deleted" subtree (and RestoreButton inside it) is newly
    // mounted, not merely revealed - its client bundle needs a moment to
    // attach after the markup appears. A click that lands on the placeholder
    // throws inside the page and leaves that form broken for the rest of the
    // test, so retrying the click afterward does not help; only waiting
    // BEFORE the first click does. networkidle does not reliably capture
    // this (React's handler attachment is not itself network activity), so
    // this is a deliberate, evidence-based wait, not a guessed one.
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Restore' }).click()

    // expect.poll(), not a single read: the test's own Prisma connection is
    // a separate pooled connection from the one the Next.js server used for
    // the restore write, and Neon's pooler does not guarantee the next read
    // on a different connection observes a just-committed write immediately
    // (the same cross-connection lag documented in R-008's duplicate-address
    // test - see docs/PROGRESS.md).
    await expect
      .poll(
        async () =>
          (await prisma.document.findUniqueOrThrow({ where: { id: created.id } })).deletedAt,
        { timeout: 10_000 },
      )
      .toBeNull()
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('an entity-scoped manager can upload to a property in their entity', async ({
    page,
  }) => {
    const { entity, property } = await seedProperty()
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await expect(page.locator('#field-doc-type')).toBeVisible()
  })

  test('a property-scoped manager cannot download a document from another property', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const owner = await createStaff('owner')
    await signIn(page, owner.email)
    await page.goto(`/properties/${theirs.id}`)
    await page.locator('#field-doc-type').selectOption('OTHER')
    await page
      .getByLabel('File')
      .setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByText('private.txt')).toBeVisible()
    const document = await prisma.document.findFirstOrThrow({
      where: { propertyId: theirs.id, fileName: 'private.txt' },
    })
    documentIds.push(document.id)

    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)
    // page.goto()'s response reflects the page actually landed on after a
    // redirect - /no-access itself renders fine (200), so the URL is the
    // check that matters, not the status of whatever it redirected to.
    await page.goto(`/api/documents/${document.id}/file`)
    await expect(page).toHaveURL(/\/no-access/)
  })
})

test.describe('accessibility', () => {
  test('a property page with documents has no detectable violations', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
