import { axeScan, expectFocusSurvived } from './fixtures.ts'
import { randomUUID } from 'node:crypto'
import {
  createTotpEnrolment,
  hashPassword,
  mintRecoveryCodes,
  sealSecret,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Unit operational data (PROP-03, R-014): access codes (versioned, sealed at
// rest, MFA-gated reveal, every reveal logged), appliances, utility
// accounts, shutoff locations. 'accesscode.reveal' is privileged
// (PRIVILEGED_PERMISSIONS) and therefore MFA-gated (ROLE-05) - the same
// class of check R-012's document-delete tests needed an MFA-enrolled
// sign-in for, and 'unit.write' (adding codes/appliances/utilities/
// shutoffs) is not, so most of this file signs in plainly.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `operational-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Operational Test',
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
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `Unit-${randomUUID().slice(0, 8)}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  return { entity, property, unit }
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.accessCode.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.appliance.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.utilityAccount.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.shutoffLocation.deleteMany({ where: { unitId: { in: unitIds } } })

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

/// Mirrors e2e/documents.spec.ts's identical helper - 'accesscode.reveal' is
/// the second privileged, MFA-gated permission this e2e suite exercises
/// through the UI (the first was 'document.delete').
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

test.describe('access codes', () => {
  test('adds a code, then reveals it - and every reveal is logged', async ({ page }) => {
    const { property, unit } = await seedProperty()
    await createMfaVerifiedOwner(page)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByText('Add or replace a code').click()
    await expectFocusSurvived(page, 'opening “Add or replace a code” — an operational-data disclosure')
    // Not getByLabel('Type') - three subsections on this page share that
    // accessible name by design (access code, shutoff, and documents'
    // upload form); #field-code-type is the access-code form's alone.
    await page.locator('#field-code-type').selectOption('LOCKBOX')
    await page.getByLabel('Label (optional)').fill('Front door')
    await page.getByLabel('Code').fill('7392')
    await page.getByRole('button', { name: 'Save code' }).click()
    // Not the "Front door" hint text under the Label field, which renders
    // regardless of whether the save succeeded - the real saved row's own
    // rendered label is the only reliable confirmation, and also the signal
    // that the post-redirect page has actually finished rendering before
    // the next step touches it again.
    await expect(page.getByText('Lockbox — Front door')).toBeVisible()

    const stored = await prisma.accessCode.findFirstOrThrow({
      where: { unitId: unit.id, type: 'LOCKBOX' },
    })
    expect(stored.sealedCode).not.toContain('7392')

    await page.getByRole('button', { name: 'Reveal' }).click()
    // EXACT, because `getByText` is a case-insensitive SUBSTRING match and
    // this page carries the property switcher - one <option> per property in
    // scope, each named `<Name>-<8 hex chars>`. A code of pure digits is also
    // valid hex, so any run in which some other spec's random suffix happens
    // to contain it resolves to two elements and dies in strict mode. That is
    // not hypothetical: `Axe House-e7392d7f` did it on R-135's sweep. The
    // revealed code is its own <span>, so an exact match cannot collide with
    // a name that merely contains it.
    await expect(page.getByText('7392', { exact: true })).toBeVisible()

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'AccessCode', entityId: stored.id, action: 'accesscode.revealed' },
    })
    expect(entry).not.toBeNull()

    const setEntry = await prisma.auditLog.findFirst({
      where: { entityType: 'AccessCode', entityId: stored.id, action: 'accesscode.set' },
    })
    expect(setEntry).not.toBeNull()
  })

  test('a second code supersedes the first, and history keeps both', async ({ page }) => {
    const { property, unit } = await seedProperty()
    await createMfaVerifiedOwner(page)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByText('Add or replace a code').click()
    await page.locator('#field-code-type').selectOption('GATE')
    await page.getByLabel('Code').fill('1111')
    await page.getByRole('button', { name: 'Save code' }).click()
    // Waits for the post-redirect render to settle before the second round
    // touches the page again - see the previous test's identical comment.
    // Not getByText('Gate') - a closed <select>'s own <option>GATE</option>
    // renders "Gate" too and is still in the DOM, just not laid out; scoping
    // to the list row is what makes this unambiguous.
    await expect(page.getByRole('listitem').filter({ hasText: 'Gate' })).toBeVisible()

    // Not an unconditional click: <details> is a native, uncontrolled
    // element, and the redirect() above re-renders this Server Component
    // subtree without React ever setting or clearing its `open` attribute -
    // so the browser's own state can very well have survived the first
    // click and left it already open. A second unconditional click on the
    // summary would then TOGGLE IT CLOSED instead of opening it, hiding the
    // form the very next line tries to fill in.
    if (!(await page.locator('#field-code-type').isVisible())) {
      await page.getByText('Add or replace a code').click()
    }
    await page.locator('#field-code-type').selectOption('GATE')
    await page.getByLabel('Code').fill('2222')
    await page.getByRole('button', { name: 'Save code' }).click()

    // expect.poll(), not a single read: the same cross-connection Neon lag
    // documented in R-008's duplicate-address test and reused throughout
    // this session's e2e suite - the test's own Prisma connection is not
    // guaranteed to observe a write the server just committed on a
    // different pooled connection on the very next query.
    await expect
      .poll(
        async () =>
          prisma.accessCode.count({ where: { unitId: unit.id, type: 'GATE' } }),
        { timeout: 10_000 },
      )
      .toBe(2)

    const versions = await prisma.accessCode.findMany({
      where: { unitId: unit.id, type: 'GATE' },
      orderBy: { version: 'asc' },
    })
    expect(versions).toHaveLength(2)
    expect(versions[0]!.effectiveTo).not.toBeNull()
    expect(versions[1]!.effectiveTo).toBeNull()

    // Exactly one current GATE code shown on the page.
    await expect(page.getByRole('listitem').filter({ hasText: 'Gate' })).toHaveCount(1)
  })

  test('a plain owner (no MFA) cannot reveal a code', async ({ page }) => {
    const { property, unit } = await seedProperty()
    await prisma.accessCode.create({
      data: {
        unitId: unit.id,
        type: 'LOCKBOX',
        sealedCode: sealSecret('9999', 'access-code'),
        version: 1,
      },
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await expect(page.getByRole('button', { name: 'Reveal' })).toHaveCount(0)
    await expect(page.getByText('••••')).toBeVisible()
  })
})

test.describe('appliances and utilities', () => {
  test('adds an appliance and removes it', async ({ page }) => {
    const { property, unit } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByText('Add an appliance').click()
    await page.getByLabel('Category').selectOption('HVAC')
    await page.getByLabel('Filter size (HVAC only)').fill('16x25x1')
    await page.getByRole('button', { name: 'Add appliance' }).click()
    await expect(page.getByText('filter 16x25x1')).toBeVisible()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('filter 16x25x1')).toHaveCount(0)

    const remaining = await prisma.appliance.count({ where: { unitId: unit.id } })
    expect(remaining).toBe(0)
  })

  test('adds a utility account', async ({ page }) => {
    const { property, unit } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByText('Add a utility account').click()
    await page.getByLabel('Utility').selectOption('WATER')
    await page.getByLabel('Provider').fill('Austin Water')
    await page.getByRole('button', { name: 'Add utility account' }).click()
    await expect(page.getByText('Water — Austin Water')).toBeVisible()
  })
})

test.describe('shutoff locations', () => {
  test('sets a shutoff location, then replaces its description', async ({ page }) => {
    const { property, unit } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByText('Set a shutoff location').click()
    await page.locator('#field-shutoff-type').selectOption('WATER_MAIN')
    await page.getByLabel('Where is it?').fill('Left side, under the hose bib.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Left side, under the hose bib.')).toBeVisible()

    await page.getByText('Set a shutoff location').click()
    await page.locator('#field-shutoff-type').selectOption('WATER_MAIN')
    await page.getByLabel('Where is it?').fill('Corrected: right side, green box.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Corrected: right side, green box.')).toBeVisible()

    const rows = await prisma.shutoffLocation.findMany({ where: { unitId: unit.id } })
    expect(rows).toHaveLength(1)
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('an entity-scoped manager can add a code on a property in their entity', async ({
    page,
  }) => {
    const { entity, property, unit } = await seedProperty()
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await expect(page).not.toHaveURL(/\/no-access/)
    await expect(page.getByText('Add or replace a code')).toBeVisible()
  })

  test('a property-scoped manager without unit.write on this property sees no write controls', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs, unit: theirUnit } = await seedProperty('Theirs')
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    const response = await page.goto(`/properties/${theirs.id}/units/${theirUnit.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('accessibility', () => {
  test('the unit detail page with operational data has no detectable violations', async ({
    page,
  }) => {
    const { property, unit } = await seedProperty()
    await prisma.accessCode.create({
      data: {
        unitId: unit.id,
        type: 'LOCKBOX',
        sealedCode: sealSecret('4821', 'access-code'),
        version: 1,
      },
    })
    await createMfaVerifiedOwner(page)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
