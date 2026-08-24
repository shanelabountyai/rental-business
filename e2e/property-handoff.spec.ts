import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// The sale / acquisition handoff packet (DOC-06, RISK-09; R-092).
//
// WHAT THE PACKET SAYS is proved character by character in
// packages/core/property/handoff.test.ts, and what it can never READ is
// proved in apps/web/lib/properties/handoff-file.test.ts. There is no PDF
// text extractor in this repo and adding a dependency to get one would be a
// worse trade than the split those two files already make.
//
// What only a browser proves is the rest: that `property.export` is
// privileged and owner-only, so the panel simply is not there for a manager
// who can otherwise run the property; that the exhibit index and the audit
// row agree about which certificates made it in; and that a confidential
// case's re-key job IS in the vendor history, because D-109 says a case's
// consequences cannot be hidden.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []
const vendorIds: string[] = []

async function createStaff(roleKey: 'owner' | 'manager', legalEntityId: string) {
  const unique = randomUUID().slice(0, 8)
  const email = `handoff-${roleKey}-${unique}@example.test`
  const enrolment = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `${roleKey} ${unique}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(enrolment.secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId },
  })
  return { ...staff, secret: enrolment.secret }
}

/// One property with everything a buyer's file needs in it. Scoped to its own
/// legal entity, always - route-boundaries.spec.ts records why at length.
async function seedProperty() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Handoff LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Handoff House-${unique}`,
      addressLine1: '9 Sale Street',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2012,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Ada',
      lastName: `Sitting-${unique}`,
      email: `ada-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date('2026-12-31T00:00:00Z'),
      rentCents: 172_500,
      depositCents: 172_500,
      rentDueDay: 1,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  // Partly applied against an earlier claim: what transfers is the REMAINDER,
  // and printing the gross would hand the buyer a bigger liability than the
  // money actually in the account.
  await prisma.deposit.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      heldCents: 172_500,
      appliedCents: 22_500,
    },
  })
  await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      label: 'Front lockbox',
      sealedCode: sealSecret('7781', 'access-code'),
      version: 1,
    },
  })
  const vendor = await prisma.vendor.create({
    data: { name: `Ace Plumbing-${unique}`, trades: ['PLUMBING'], serviceAreas: ['77002'] },
  })
  vendorIds.push(vendor.id)
  await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      vendorId: vendor.id,
      status: 'CLOSED',
      scope: 'Replace the water heater',
      completedAt: new Date('2026-03-04T15:00:00Z'),
      invoiceCents: 128_500,
    },
  })
  await prisma.warranty.create({
    data: {
      propertyId: property.id,
      category: 'ROOF',
      provider: 'Sunbelt Roofing',
      coverageSummary: 'Twenty-year workmanship warranty on the 2021 re-roof.',
      expiresOn: new Date('2041-06-30T00:00:00Z'),
    },
  })
  await prisma.hoaInfo.create({
    data: { propertyId: property.id, name: 'Sale Street HOA', hasRentalCap: false },
  })
  return { entity, property, unit, lease, tenant, vendor, unique }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: { in: vendorIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('generates the certificates, assembles the packet, and records what it claimed', async ({
  page,
}) => {
  const seed = await seedProperty()
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/properties/${seed.property.id}`)

  const panel = page.getByRole('region', { name: 'Sale and acquisition handoff' })
  await expect(panel.getByText('0 generated so far, for 1 tenancy')).toBeVisible()

  await panel.getByRole('button', { name: 'Generate the estoppel certificates' }).click()
  await expect(page.getByText('1 estoppel certificate generated')).toBeVisible()

  const certificate = await prisma.document.findFirstOrThrow({
    where: { propertyId: seed.property.id, type: 'ESTOPPEL_CERTIFICATE' },
  })
  expect(certificate.leaseId).toBe(seed.lease.id)
  // No tenantId: the certificate is about the TENANCY and carries everybody
  // on it, so hanging it off one of two people would make it invisible on the
  // other's record.
  expect(certificate.tenantId).toBeNull()

  const represented = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: seed.lease.id, action: 'lease.estoppel_generated' },
  })
  // What was REPRESENTED, alongside the document that represented it - the
  // three numbers a tenant disputes afterwards. The deposit is the REMAINDER
  // after the applied portion, not the gross.
  expect(represented.after).toMatchObject({
    rentCents: 172_500,
    depositHeldCents: 150_000,
    balanceCents: 0,
  })

  await panel.getByRole('button', { name: 'Assemble the handoff packet' }).click()
  await expect(page.getByText('Packet archived.')).toBeVisible()

  const packet = await prisma.document.findFirstOrThrow({
    where: { propertyId: seed.property.id, type: 'HANDOFF_PACKET' },
  })
  // The house, not a tenancy: hanging it off one of three leases would be a
  // false claim about which.
  expect(packet.leaseId).toBeNull()
  expect(packet.sizeBytes).toBeGreaterThan(0)

  const archived = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: seed.property.id, action: 'property.handoff_packet_archived' },
  })
  expect(archived.after).toMatchObject({
    leaseCount: 1,
    depositHeldCents: 150_000,
    accessCodeCount: 1,
    vendorJobCount: 1,
    estoppelsAttached: 1,
    estoppelsNotAttached: [],
  })

  // It serves as a real file, which is the only part of "the packet works"
  // that a unit test cannot reach.
  const response = await page.request.get(`/api/documents/${packet.id}/file`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('pdf')

  // Assembled again, and the first one is still there. A packet is a claim
  // about the file on a date; overwriting it would destroy the record of what
  // somebody was actually handed.
  await page.reload()
  await panel.getByRole('button', { name: 'Assemble the handoff packet' }).click()
  await expect(page.getByText('Packet archived.')).toBeVisible()
  expect(
    await prisma.document.count({
      where: { propertyId: seed.property.id, type: 'HANDOFF_PACKET' },
    }),
  ).toBe(2)
})

test('names the tenancy with no certificate instead of shipping a packet that looks complete', async ({
  page,
}) => {
  const seed = await seedProperty()
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/properties/${seed.property.id}`)

  // Straight to the packet, no certificates. D-50: never a silent gap.
  const panel = page.getByRole('region', { name: 'Sale and acquisition handoff' })
  await panel.getByRole('button', { name: 'Assemble the handoff packet' }).click()
  await expect(
    page.getByText('1 tenancy is named on the exhibit index with no estoppel certificate'),
  ).toBeVisible()

  const archived = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: seed.property.id, action: 'property.handoff_packet_archived' },
  })
  // The audit row and the packet's own index have to agree about what is in
  // the file - the TRUE outcome, not the hoped-for one.
  expect(archived.after).toMatchObject({
    estoppelsAttached: 0,
    estoppelsNotAttached: [seed.lease.id],
  })
})

test('a confidential case’s re-key job is in the vendor history, because it has to be', async ({
  page,
}) => {
  const seed = await seedProperty()
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${seed.lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page.getByLabel('What is going on').fill('Locks need changing today.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${seed.unique}`)
  await page.getByRole('button', { name: 'Open the case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  await page
    .getByLabel('Who the locksmith should ring if anybody else asks')
    .fill('Sam Rivera on 555-0100')
  await page.getByRole('button', { name: 'Order the re-key and retire the codes' }).click()
  await expect(page.getByText('Re-key ordered as work order')).toBeVisible()

  // The job has to be done, so it has to be dispatchable, so it is an
  // ordinary work order on every maintenance screen (D-109). Completed here
  // so it reaches the packet's "work done" section like any other job.
  const rekey = await prisma.workOrder.findFirstOrThrow({
    where: { propertyId: seed.property.id, priority: 'URGENT' },
  })
  expect(rekey.restrictedPartyNote).not.toBeNull()
  await prisma.workOrder.update({
    where: { id: rekey.id },
    data: { status: 'CLOSED', completedAt: new Date(), invoiceCents: 24_000 },
  })

  await page.goto(`/properties/${seed.property.id}`)
  const panel = page.getByRole('region', { name: 'Sale and acquisition handoff' })
  await panel.getByRole('button', { name: 'Assemble the handoff packet' }).click()
  await expect(page.getByText('Packet archived')).toBeVisible()

  const archived = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: seed.property.id, action: 'property.handoff_packet_archived' },
  })
  // Two jobs: the water heater and the re-key. The re-key's NOTE is what
  // never gets in, and handoff-file.test.ts is what holds that line - the
  // column is one word away from being selected by somebody who has not read
  // the header.
  expect(archived.after).toMatchObject({ vendorJobCount: 2 })
})

test('a manager who runs the property cannot export it', async ({ page }) => {
  const seed = await seedProperty()
  const manager = await createStaff('manager', seed.entity.id)

  await signIn(page, manager)
  await page.goto(`/properties/${seed.property.id}`)

  // They can see the property perfectly well - this is not a scoping failure.
  await expect(page.getByRole('heading', { name: seed.property.name })).toBeVisible()
  // `property.export` is owner-only by construction: `owner` carries
  // PERMISSIONS entire and no other role names it (D-5 keeps it an ordinary
  // grant an owner can hand over).
  await expect(page.getByRole('region', { name: 'Sale and acquisition handoff' })).toHaveCount(0)
  expect(
    await prisma.document.count({
      where: { propertyId: seed.property.id, type: 'HANDOFF_PACKET' },
    }),
  ).toBe(0)
})
