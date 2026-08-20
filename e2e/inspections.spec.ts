import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The inspection engine (INSP-01, R-068).
//
// Pure status/validation logic is proved directly in
// packages/core/inspections/{status,validate}.test.ts, and the reads
// against a real database in apps/web/lib/inspections/*.test.ts and
// apps/web/lib/portal/inspection-queries.test.ts. The auto-finalize job is
// proved directly against a real database in
// apps/web/lib/inspections/auto-finalize-job.test.ts. What only a browser
// proves is here: a PM building a checklist, starting an inspection from
// it, walking every item, attaching a photo, finishing, and locking it
// (phase 1); and a tenant reviewing that same report from their own portal
// and signing it, which locks it in the same step (phase 2).

// A 1x1 PNG - small enough to inline, real enough that the upload path
// actually runs. Same fixture e2e/notices.spec.ts's own PNG_1PX is.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const templateIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `inspection-${unique}@example.test`,
      name: `Inspection Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedUnit() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Inspection LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Inspection House-${unique}`,
      addressLine1: '15 Checklist Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  return { property, unit, unique }
}

/// A unit with an ACTIVE lease and its own primary tenant - what the
/// tenant-portal e-sign test needs, distinct from `seedUnit()`'s bare
/// VACANT unit (which the phase-1 staff-only test still uses, and which
/// deliberately has no lease to attach an inspection to).
async function seedUnitWithTenant() {
  const { property, unit, unique } = await seedUnit()
  await prisma.unit.update({ where: { id: unit.id }, data: { status: 'OCCUPIED' } })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Robin', lastName: `Reviewer-${unique}`, email: `robin-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return { property, unit, tenant, lease, unique }
}

/// Mints a magic link the way the sign-in action would - the portal has no
/// password sign-in at all (e2e/notices.spec.ts's own identical helper).
async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  await prisma.inspectionTemplate.updateMany({
    where: { id: { in: templateIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a PM builds a checklist, walks an inspection start to finish, and locks it', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit, unique } = await seedUnit()
  await signIn(page, staff.email)

  // Build the checklist.
  await page.goto('/inspections/templates/new')
  await page.getByLabel('Name').fill(`Standard-${unique}`)
  // A fixed set of blank row slots (InspectionTemplateForm's own comment on
  // why), not a client-side "Add item" button.
  await page.getByLabel('Room').first().fill('Kitchen')
  await page.getByLabel('Item').first().fill('Refrigerator')
  await page.getByLabel('Room').nth(1).fill('Bathroom')
  await page.getByLabel('Item').nth(1).fill('Tub')
  await page.getByRole('button', { name: 'Save' }).click()
  // Excludes "new" itself, which also matches [a-z0-9]+ - the same
  // `(?!new$)` exclusion this repo's own e2e specs already use elsewhere.
  await expect(page).toHaveURL(/\/inspections\/templates\/(?!new$)[a-z0-9]+$/)

  const template = await prisma.inspectionTemplate.findFirstOrThrow({
    where: { name: `Standard-${unique}` },
  })
  templateIds.push(template.id)
  expect(template.items).toEqual([
    { room: 'Kitchen', item: 'Refrigerator' },
    { room: 'Bathroom', item: 'Tub' },
  ])

  // Start an inspection from it.
  await page.goto('/inspections/new')
  await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
  await page.getByLabel('Type').selectOption('PERIODIC')
  await page.getByLabel('Checklist').selectOption({ label: `Standard-${unique}` })
  await page.getByRole('button', { name: 'Start inspection' }).click()
  await expect(page).toHaveURL(/\/inspections\/(?!new$)[a-z0-9]+$/)

  const inspection = await prisma.inspection.findFirstOrThrow({ where: { unitId: unit.id } })
  expect(inspection.templateId).toBe(template.id)

  await expect(page.getByText('Kitchen — Refrigerator')).toBeVisible()
  await expect(page.getByText('Bathroom — Tub')).toBeVisible()

  // "Finish walk" is refused server-side before every item is recorded.
  await page.getByRole('button', { name: 'Finish walk' }).click()
  await expect(page.getByText(/still need/)).toBeVisible()

  const items = await prisma.inspectionItem.findMany({ where: { inspectionId: inspection.id } })
  const kitchen = items.find((i) => i.room === 'Kitchen')!
  const bathroom = items.find((i) => i.room === 'Bathroom')!

  // Walk each item.
  const kitchenForm = page.locator('li', { hasText: 'Kitchen — Refrigerator' });
  await kitchenForm.getByLabel('Condition').selectOption('GOOD')
  await kitchenForm.getByLabel('Notes').fill('Clean, working.')
  await kitchenForm.getByRole('button', { name: 'Save' }).click()

  const bathroomForm = page.locator('li', { hasText: 'Bathroom — Tub' });
  await bathroomForm.getByLabel('Condition').selectOption('FAIR')
  await bathroomForm.getByLabel('Notes').fill('Minor staining.')
  await bathroomForm.getByRole('button', { name: 'Save' }).click()

  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: kitchen.id } })).condition)
    .toBe('GOOD')
  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: bathroom.id } })).condition)
    .toBe('FAIR')

  // Finish, sign, lock.
  await page.getByRole('button', { name: 'Finish walk' }).click()
  await expect(page.getByText('PERIODIC · Pending signature')).toBeVisible()

  await page.getByRole('button', { name: 'Record tenant signature' }).click()
  await expect(page.getByText('PERIODIC · Signed')).toBeVisible()

  await page.getByRole('button', { name: 'Lock report' }).click()
  await expect(page.getByText(/cannot be edited/)).toBeVisible()

  const locked = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
  expect(locked.lockedAt).not.toBeNull()
  expect(locked.tenantSignedAt).not.toBeNull()
  expect(locked.performedAt).not.toBeNull()

  // Locked means locked - no more per-item forms, read-only rows instead.
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await expect(page.getByText('Clean, working.')).toBeVisible()

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'inspection.locked', entityId: inspection.id },
  })
  expect(audited).not.toBeNull()
})

test('a photo attaches to an item, and the tenant reviews and signs the report from their own portal', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { property, unit, tenant, unique } = await seedUnitWithTenant()
  await signIn(page, staff.email)

  await page.goto('/inspections/templates/new')
  await page.getByLabel('Name').fill(`MoveIn-${unique}`)
  await page.getByLabel('Room').first().fill('Living room')
  await page.getByLabel('Item').first().fill('Carpet')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/inspections\/templates\/(?!new$)[a-z0-9]+$/)

  await page.goto('/inspections/new')
  await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
  await page.getByLabel('Type').selectOption('MOVE_IN')
  await page.getByLabel('Checklist').selectOption({ label: `MoveIn-${unique}` })
  await page.getByRole('button', { name: 'Start inspection' }).click()
  await expect(page).toHaveURL(/\/inspections\/(?!new$)[a-z0-9]+$/)

  const inspection = await prisma.inspection.findFirstOrThrow({ where: { unitId: unit.id } })
  expect(inspection.leaseId).not.toBeNull()

  const itemForm = page.locator('li', { hasText: 'Living room — Carpet' })
  await itemForm.getByLabel('Add a photo').setInputFiles({
    name: 'carpet.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  })
  await itemForm.getByRole('button', { name: 'Upload' }).click()
  await expect(itemForm.getByRole('img')).toBeVisible()

  const item = await prisma.inspectionItem.findFirstOrThrow({ where: { inspectionId: inspection.id } })
  const photo = await prisma.document.findFirstOrThrow({ where: { inspectionItemId: item.id } })
  expect(photo.type).toBe('INSPECTION_PHOTO')
  // Set from the inspection's own lease - the tenant portal's document
  // visibility rule (DOC-03) needs this to show the photo back to them.
  expect(photo.leaseId).toBe(inspection.leaseId)

  await itemForm.getByLabel('Condition').selectOption('GOOD')
  await itemForm.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: item.id } })).condition)
    .toBe('GOOD')

  await page.getByRole('button', { name: 'Finish walk' }).click()
  await expect(page.getByText('MOVE_IN · Pending signature')).toBeVisible()

  // finishInspection() notifies the tenant with a direct link - the real
  // signal a tenant would follow, rather than this test navigating there
  // by knowing the id in advance.
  await expect
    .poll(() =>
      prisma.notification.count({
        where: {
          recipientType: 'TENANT',
          recipientId: tenant.id,
          templateKey: 'inspection.signature_needed',
        },
      }),
    )
    .toBeGreaterThan(0)

  const anon = await browser.newContext()
  const tenantPage = await anon.newPage()
  await tenantPage.goto(await magicLinkFor(tenant.id))
  await tenantPage.goto('/portal/papers')
  await expect(
    tenantPage.getByRole('link', { name: /Review and sign your inspection report/ }),
  ).toBeVisible()
  await tenantPage.getByRole('link', { name: /Review and sign your inspection report/ }).click()

  await expect(tenantPage.getByText('Living room — Carpet')).toBeVisible()
  await expect(tenantPage.getByRole('img')).toBeVisible()
  // The tenant's own read-only review renders no condition/notes forms -
  // only staff can still edit at this point.
  await expect(tenantPage.getByRole('button', { name: 'Save' })).toHaveCount(0)

  await tenantPage.getByLabel(/reviewed this report/).check()
  // exact: true - "Sign" also substring-matches the portal header's own
  // "Sign out" button.
  await tenantPage.getByRole('button', { name: 'Sign', exact: true }).click()

  // Signing locks in the same step (unlike the staff path) - the same
  // Server-Action-always-refreshes trap this page's own comment documents:
  // this branch, not a transient banner, is what a tenant who just signed
  // actually sees.
  await expect(tenantPage.getByText(/You signed this report on/)).toBeVisible()

  // No longer shows up as awaiting signature, on a fresh visit.
  await tenantPage.goto('/portal/papers')
  await expect(
    tenantPage.getByRole('link', { name: /Review and sign your inspection report/ }),
  ).toHaveCount(0)
  await anon.close()

  const signed = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
  expect(signed.tenantSignedAt).not.toBeNull()
  expect(signed.lockedAt).not.toBeNull()

  const signedAudit = await prisma.auditLog.findFirst({
    where: { action: 'inspection.signed', entityId: inspection.id },
  })
  expect(signedAudit?.actorType).toBe('TENANT')
  const lockedAudit = await prisma.auditLog.findFirst({
    where: { action: 'inspection.locked', entityId: inspection.id },
  })
  expect(lockedAudit?.after).toMatchObject({ signed: true })
})

test('a tenant self-guides a move-in walkthrough from their own portal (INSP-05)', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { property, unit, tenant, lease, unique } = await seedUnitWithTenant()
  await signIn(page, staff.email)

  await page.goto('/inspections/templates/new')
  await page.getByLabel('Name').fill(`SelfGuided-${unique}`)
  await page.getByLabel('Room').first().fill('Kitchen')
  await page.getByLabel('Item').first().fill('Stove')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/inspections\/templates\/(?!new$)[a-z0-9]+$/)

  const template = await prisma.inspectionTemplate.findFirstOrThrow({
    where: { name: `SelfGuided-${unique}` },
  })
  templateIds.push(template.id)

  await page.goto('/inspections/new')
  await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
  await page.getByLabel('Type').selectOption('MOVE_IN')
  await page.getByLabel(/self-guided/).check()
  await page.getByLabel('Checklist').selectOption({ label: `SelfGuided-${unique}` })
  await page.getByRole('button', { name: 'Start inspection' }).click()
  await expect(page).toHaveURL(/\/inspections\/(?!new$)[a-z0-9]+$/)

  const inspection = await prisma.inspection.findFirstOrThrow({ where: { unitId: unit.id } })
  expect(inspection.selfGuided).toBe(true)

  // Creating a self-guided report notifies the tenant with a direct link -
  // the real signal a tenant would follow, rather than this test navigating
  // there by knowing the id in advance.
  await expect
    .poll(() =>
      prisma.notification.count({
        where: { recipientType: 'TENANT', recipientId: tenant.id, templateKey: 'inspection.move_in_ready' },
      }),
    )
    .toBeGreaterThan(0)

  const anon = await browser.newContext()
  const tenantPage = await anon.newPage()
  await tenantPage.goto(await magicLinkFor(tenant.id))
  await tenantPage.goto('/portal/papers')
  await expect(
    tenantPage.getByRole('link', { name: /Complete your move-in walkthrough/ }),
  ).toBeVisible()
  await tenantPage.getByRole('link', { name: /Complete your move-in walkthrough/ }).click()

  const itemForm = tenantPage.locator('li', { hasText: 'Kitchen — Stove' })
  await itemForm.getByLabel('Add a photo').setInputFiles({
    name: 'stove.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  })
  await itemForm.getByRole('button', { name: 'Upload' }).click()
  await expect(itemForm.getByRole('img')).toBeVisible()

  const item = await prisma.inspectionItem.findFirstOrThrow({ where: { inspectionId: inspection.id } })
  const photo = await prisma.document.findFirstOrThrow({ where: { inspectionItemId: item.id } })
  expect(photo.leaseId).toBe(inspection.leaseId)

  await itemForm.getByLabel('Condition').selectOption('NEW')
  await itemForm.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: item.id } })).condition)
    .toBe('NEW')

  await tenantPage.getByRole('button', { name: 'Finish walkthrough' }).click()
  await expect(tenantPage.getByText(/reviewed this report/)).toBeVisible()

  await tenantPage.getByLabel(/reviewed this report/).check()
  await tenantPage.getByRole('button', { name: 'Sign', exact: true }).click()
  await expect(tenantPage.getByText(/You signed this report on/)).toBeVisible()

  const done = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
  expect(done.performedAt).not.toBeNull()
  expect(done.performedByStaffId).toBeNull()
  expect(done.tenantSignedAt).not.toBeNull()
  expect(done.lockedAt).not.toBeNull()

  // No longer prompts on a fresh visit.
  await tenantPage.goto('/portal/papers')
  await expect(
    tenantPage.getByRole('link', { name: /Complete your move-in walkthrough/ }),
  ).toHaveCount(0)
  await anon.close()

  // A traditional staff-performed MOVE_IN inspection on the SAME lease
  // (selfGuided false, unperformed) stays read-only on the tenant's own
  // portal - `selfGuided` gates the write, not just `type === 'MOVE_IN'` or
  // "not yet performed". A tenant who happens to know this id gets the same
  // read-only rows the phase-2 review page has always shown, never a form.
  const staffInspection = await prisma.inspection.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      type: 'MOVE_IN',
      selfGuided: false,
      items: { create: [{ room: 'Bedroom', item: 'Closet', order: 0 }] },
    },
  })
  const blocked = await browser.newContext()
  const blockedPage = await blocked.newPage()
  await blockedPage.goto(await magicLinkFor(tenant.id))
  await blockedPage.goto(`/portal/papers/inspections/${staffInspection.id}`)
  await expect(blockedPage.getByText('Bedroom — Closet')).toBeVisible()
  await expect(blockedPage.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await expect(blockedPage.getByRole('button', { name: 'Finish walkthrough' })).toHaveCount(0)
  await blocked.close()
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: staffInspection.id } })
  await prisma.inspection.deleteMany({ where: { id: staffInspection.id } })
})

test('a move-out inspection copies the move-in checklist and shows the side-by-side comparison (R-070)', async ({
  page,
}) => {
  const staff = await createStaff()
  const { unit, lease } = await seedUnitWithTenant()

  const moveIn = await prisma.inspection.create({
    data: {
      propertyId: unit.propertyId,
      unitId: unit.id,
      leaseId: lease.id,
      type: 'MOVE_IN',
      lockedAt: new Date(),
      items: {
        create: [{ room: 'Kitchen', item: 'Refrigerator', condition: 'GOOD', order: 0 }],
      },
    },
  })
  const template = await prisma.inspectionTemplate.create({
    data: {
      name: `Ignored template ${randomUUID().slice(0, 8)}`,
      items: [{ room: 'Bathroom', item: 'Toilet' }],
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(template.id)

  await signIn(page, staff.email)
  await page.goto('/inspections/new')
  await page.getByLabel('Unit').selectOption(unit.id)
  await page.getByLabel('Type').selectOption('MOVE_OUT')
  await page.getByLabel('Checklist').selectOption(template.id)
  await page.getByRole('button', { name: 'Start inspection' }).click()
  await page.waitForURL(/\/inspections\/(?!new$)[a-z0-9]+$/)

  // The move-in checklist, NOT the (ignored) template selected above.
  await expect(page.getByText('Kitchen — Refrigerator')).toBeVisible()
  await expect(page.getByText('Bathroom — Toilet')).toHaveCount(0)
  // Scoped to the move-in panel itself, not a bare getByText('Good') - the
  // move-out item's own Condition <select> carries an identical "Good"
  // <option>, and matching both is a strict-mode violation.
  const moveInPanel = page.getByText('At move-in').locator('..')
  await expect(moveInPanel).toBeVisible()
  await expect(moveInPanel).toContainText('Good')

  const id = new URL(page.url()).pathname.split('/').pop()!
  const created = await prisma.inspection.findUniqueOrThrow({
    where: { id },
    include: { items: true },
  })
  expect(created.type).toBe('MOVE_OUT')
  expect(created.leaseId).toBe(lease.id)
  expect(created.items).toHaveLength(1)
  const moveInItem = await prisma.inspectionItem.findFirstOrThrow({ where: { inspectionId: moveIn.id } })
  expect(created.items[0]!.moveInItemId).toBe(moveInItem.id)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'inspection.created', entityId: id },
  })
  expect(audited?.after).toMatchObject({ copiedFromInspectionId: moveIn.id })
})
