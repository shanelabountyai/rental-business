import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// Bulk CSV import (R-168, PRD §6.8) - entities/tenants/leases with a
// dry-run diff and per-row errors, plus the bulk document upload keyed by
// address + type. Opening balances are a separate, not-yet-built item
// (D-11), so nothing here asserts a ledger effect.

const PASSWORD = 'correct-horse-battery-staple'
const HEADER = [
  'legal_entity_name',
  'legal_entity_type',
  'legal_entity_formation_state',
  'property_address_line1',
  'property_address_line2',
  'property_city',
  'property_state',
  'property_postal_code',
  'property_name',
  'property_type',
  'property_timezone',
  'property_history_starts_on',
  'unit_name',
  'unit_status',
  'unit_market_rent_dollars',
  'tenant_first_name',
  'tenant_last_name',
  'tenant_email',
  'tenant_phone',
  'lease_starts_on',
  'lease_ends_on',
  'lease_rent_dollars',
  'lease_rent_due_day',
  'lease_deposit_dollars',
  'lease_deposit_arrangement',
].join(',')

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createOwner() {
  const email = `import-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Import Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, password: PASSWORD }
}

async function createManager(scope: { propertyId?: string; legalEntityId?: string }) {
  const email = `import-manager-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Import Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, ...scope },
  })
  return { ...staff, password: PASSWORD }
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  const leases = await prisma.lease.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } })
  const leaseIds = leases.map((l) => l.id)
  const tenantIds = (
    await prisma.leaseTenant.findMany({ where: { leaseId: { in: leaseIds } }, select: { tenantId: true } })
  ).map((lt) => lt.tenantId)
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({ where: { propertyId: { in: propertyIds } }, select: { propertyId: true } })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({ where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } } })
  await prisma.property.updateMany({ where: { id: { in: [...auditedProperties] } }, data: { active: false } })

  const stillReferenced = new Set(
    (await prisma.property.findMany({ where: { legalEntityId: { in: entityIds } }, select: { legalEntityId: true } })).map(
      (row) => row.legalEntityId,
    ),
  )
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } } })
  await prisma.legalEntity.updateMany({
    where: { id: { in: entityIds.filter((id) => stillReferenced.has(id)) } },
    data: { active: false },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  // A staff row an AuditLog entry points at cannot be deleted - the FK is
  // `onDelete: Restrict` and the log itself refuses the UPDATE a cascading
  // SetNull would otherwise need (see e2e/documents.spec.ts's identical
  // cleanup). Every action here writes an audit entry, so deactivate rather
  // than assume any of these staff are unreferenced.
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({ where: { actorStaffId: { in: staffIds } }, select: { actorStaffId: true } })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } } })
  await prisma.staffUser.updateMany({ where: { id: { in: [...auditedStaff] } }, data: { active: false } })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

function csvRow(overrides: Record<string, string> = {}, address: { line1: string; entityName: string }): string {
  const defaults: Record<string, string> = {
    legal_entity_name: address.entityName,
    legal_entity_type: 'LLC',
    legal_entity_formation_state: 'TX',
    property_address_line1: address.line1,
    property_address_line2: '',
    property_city: 'Austin',
    property_state: 'TX',
    property_postal_code: '78701',
    property_name: 'Imported House',
    property_type: 'SINGLE_FAMILY',
    property_timezone: 'America/Chicago',
    property_history_starts_on: '2024-06-01',
    unit_name: 'Main house',
    unit_status: 'OCCUPIED',
    unit_market_rent_dollars: '1500',
    tenant_first_name: 'Grant',
    tenant_last_name: 'Okafor',
    tenant_email: `grant-${randomUUID().slice(0, 8)}@example.test`,
    tenant_phone: '',
    lease_starts_on: '2024-06-01',
    lease_ends_on: '',
    lease_rent_dollars: '1500',
    lease_rent_due_day: '1',
    lease_deposit_dollars: '1500',
    lease_deposit_arrangement: 'CASH',
  }
  const merged = { ...defaults, ...overrides }
  return HEADER.split(',').map((column) => merged[column]).join(',')
}

test.describe('bulk import (R-168)', () => {
  test('previews, then commits a new entity/property/unit/tenant/lease', async ({ page }) => {
    const owner = await createOwner()
    await signIn(page, owner.email)

    const entityName = `Import LLC ${randomUUID().slice(0, 8)}`
    const line1 = `${randomUUID().slice(0, 8)} Import Ave`
    const csv = `${HEADER}\n${csvRow({}, { line1, entityName })}`

    await page.goto('/import')
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.getByRole('button', { name: 'Preview' }).click()

    await expect(page.getByText('New legal entities')).toBeVisible()
    const summaryRow = page.locator('dt', { hasText: 'New legal entities' }).locator('xpath=following-sibling::dd[1]')
    await expect(summaryRow).toHaveText('1')

    await page.getByRole('button', { name: 'Import these rows' }).click()
    await expect(page.getByText(/Imported 1 tenant across 1 lease/)).toBeVisible()

    const property = await prisma.property.findFirstOrThrow({ where: { addressLine1: line1 } })
    propertyIds.push(property.id)
    entityIds.push(property.legalEntityId)
    expect(property.historyStartsOn?.toISOString().slice(0, 10)).toBe('2024-06-01')

    const lease = await prisma.lease.findFirstOrThrow({
      where: { propertyId: property.id },
      include: { leaseTenants: { include: { tenant: true } } },
    })
    expect(lease.origin).toBe('INHERITED')
    expect(lease.status).toBe('DRAFT')
    expect(lease.depositTransferStatus).toBe('UNKNOWN')
    expect(lease.leaseTenants).toHaveLength(1)
    expect(lease.leaseTenants[0]!.isPrimary).toBe(true)
    expect(lease.leaseTenants[0]!.tenant.firstName).toBe('Grant')
  })

  test('reports a per-row error and hides the commit button until it is fixed', async ({ page }) => {
    const owner = await createOwner()
    await signIn(page, owner.email)

    const entityName = `Import LLC ${randomUUID().slice(0, 8)}`
    const line1 = `${randomUUID().slice(0, 8)} Import Ave`
    const csv = `${HEADER}\n${csvRow({ tenant_last_name: '' }, { line1, entityName })}`

    await page.goto('/import')
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.getByRole('button', { name: 'Preview' }).click()

    await expect(page.getByText('Last name is required.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import these rows' })).toHaveCount(0)

    const property = await prisma.property.findFirst({ where: { addressLine1: line1 } })
    expect(property).toBeNull()
  })

  test('a property-scoped manager cannot reach the import page', async ({ page }) => {
    const entity = await prisma.legalEntity.create({ data: { name: `Scope LLC ${randomUUID()}`, type: 'LLC' } })
    entityIds.push(entity.id)
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `Scope House ${randomUUID().slice(0, 8)}`,
        addressLine1: `${randomUUID().slice(0, 8)} Scope St`,
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    propertyIds.push(property.id)
    const manager = await createManager({ propertyId: property.id })
    await signIn(page, manager.email)

    await page.goto('/import')
    await expect(page).toHaveURL(/\/no-access/)
  })

  test('the import page has no detectable accessibility violations', async ({ page }) => {
    const owner = await createOwner()
    await signIn(page, owner.email)
    await page.goto('/import')
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.describe('bulk document upload (R-168)', () => {
  test('uploads a file matched to an existing property by address', async ({ page }) => {
    const entity = await prisma.legalEntity.create({ data: { name: `Docs LLC ${randomUUID()}`, type: 'LLC' } })
    entityIds.push(entity.id)
    const line1 = `${randomUUID().slice(0, 8)} Manifest Rd`
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: 'Manifest House',
        addressLine1: line1,
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    propertyIds.push(property.id)
    const owner = await createOwner()
    await signIn(page, owner.email)

    const manifest = ['property_address_line1,property_postal_code,type,file_name', `${line1},78701,DEED,deed.txt`].join(
      '\n',
    )

    await page.goto('/import')
    await page
      .getByLabel('Manifest CSV')
      .setInputFiles({ name: 'manifest.csv', mimeType: 'text/csv', buffer: Buffer.from(manifest) })
    await page
      .getByLabel('Files')
      .setInputFiles({ name: 'deed.txt', mimeType: 'text/plain', buffer: Buffer.from('the deed') })
    await page.getByRole('button', { name: 'Upload' }).click()

    await expect(page.getByText('Uploaded 1 of 1 files.')).toBeVisible()
    const document = await prisma.document.findFirstOrThrow({ where: { propertyId: property.id, fileName: 'deed.txt' } })
    expect(document.type).toBe('DEED')
  })
})
