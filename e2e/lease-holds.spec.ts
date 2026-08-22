import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Lease holds (RISK-11, RISK-12; R-084).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES: THAT THE WARNING IS ON THE SCREEN WHERE THE
// MISTAKE IS MADE.
//
// The effect table is unit-tested in packages/core/holds, and the two sweeps
// that consult it are proved against a real database in
// lib/holds/holds.test.ts. Neither of those can show the thing this item is
// actually for — that somebody who opens an eviction case on a tenancy under
// a bankruptcy stay is told so, on first paint, before they touch anything.
// A banner that renders only after hydration would pass every test in both
// files.
//
// The second load-bearing assertion here is the permission split: a manager
// WITHOUT `hold.lift_protected` can place a hold and cannot take a protected
// one off. That split is the whole of "manager-or-above to lift SCRA", and
// it is only observable through a real session.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const roleIds: string[] = []

async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Hold LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Hold House-${stamp}`,
      addressLine1: '11 Stay Street',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Hold', lastName: `Tenant-${stamp}` },
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  return { property, unit, lease, tenant }
}

/// MFA ENROLLED ON EVERY FIXTURE. `hold.lift_protected` is privileged and
/// R-004 requires a verified second factor for it — a staff user without one
/// gets redirected to enrolment instead of the refusal this file is testing,
/// which is the product working and reads as a broken page.
async function seedStaff(options: {
  roleKey: 'owner' | 'manager'
  /// Null grants PORTFOLIO-WIDE. `/evictions/[id]` opens with an unscoped
  /// `requirePermission('eviction.manage')`, so a property-scoped grant sends
  /// the very person whose job this is to /no-access — the same distinction
  /// fee-waiver.spec.ts records for the /money report, and worth exercising
  /// rather than papering over.
  propertyId: string | null
}) {
  const email = `hold-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Hold Manager',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: options.roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      ...(options.propertyId ? { propertyId: options.propertyId } : {}),
    },
  })
  return { ...staff, secret }
}

/// A manager who may place and lift ordinary holds but NOT protected ones.
/// A bespoke Role row rather than an edit to the seeded `manager` — roles are
/// data (D-5), so "this deployment does not let managers lift an SCRA hold"
/// is an ordinary configuration, and mutating the shared seeded role would
/// leak into every other spec.
async function seedUnprivilegedManager(propertyId: string) {
  const email = `hold-junior-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const seeded = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  const role = await prisma.role.create({
    data: {
      key: `manager_no_protected_${randomUUID().slice(0, 8)}`,
      name: 'Manager (no protected lifts)',
      description: 'Manager without hold.lift_protected — R-084 permission split.',
      permissions: seeded.permissions.filter((p) => p !== 'hold.lift_protected'),
      defaultApproveWorkOrderCents: seeded.defaultApproveWorkOrderCents,
      defaultWaiveFeeCents: seeded.defaultWaiveFeeCents,
    },
  })
  roleIds.push(role.id)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Junior Manager',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId },
  })
  return { ...staff, secret }
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

// Login is rate-limited per IP (R-003) and every test here signs in; without
// a distinct forwarded-for the later ones throttle and read as a broken page.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // LeaseHold points at StaffUser with onDelete: Restrict and every action
  // here writes an append-only audit row, so nothing is deleted — the roots
  // are retired, which is the pattern CLAUDE.md names.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  // The bespoke Role rows CAN go — nothing append-only points at a Role, and
  // leaving one per run accumulates rows in the shared test database.
  await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
  await prisma.lease.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { status: 'ENDED' },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({
    where: { id: { in: entityIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test('placing a hold puts a persistent banner on the tenancy, naming what it switched off', async ({
  page,
}) => {
  const { property, lease } = await seedTenancy()
  const staff = await seedStaff({ roleKey: 'owner', propertyId: property.id })

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await expect(page.getByRole('heading', { name: /under a hold/i })).toHaveCount(0)

  await page.getByLabel('Hold type').selectOption('bankruptcy')
  // The effects are shown BEFORE the hold is placed, because the type is
  // what somebody chooses and the consequences follow from it.
  await expect(page.getByText(/no late fees accrue/i)).toBeVisible()
  await page.getByLabel(/^Why \(required\)/).fill('Chapter 7 filed 2026-08-01, case no. 26-31234.')
  await page.getByRole('button', { name: 'Place hold' }).click()

  await expect(page.getByRole('heading', { name: /under a hold/i })).toBeVisible()
  await expect(page.getByText(/automatic stay/i).first()).toBeVisible()
  await expect(page.getByText(/case no\. 26-31234/).first()).toBeVisible()
  // It warns; it does not block. Serving under a lifted stay is lawful and
  // the product does not make that judgement.
  await expect(page.getByText(/warning, not a refusal/i)).toBeVisible()
})

test('the banner follows the tenancy onto the eviction case file', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedStaff({ roleKey: 'owner', propertyId: null })
  await prisma.leaseHold.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      type: 'MILITARY_SCRA',
      reason: 'Orders sighted 2026-07-14; deployed to Fort Hood.',
      placedByStaffId: staff.id,
    },
  })
  const evictionCase = await prisma.evictionCase.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      openedByStaffId: staff.id,
      notes: 'Rent unpaid since June.',
    },
  })

  await signIn(page, staff)
  await page.goto(`/evictions/${evictionCase.id}`)

  // THE ASSERTION THIS FILE EXISTS FOR. The person about to record a filing
  // is told, on the filing screen, that the tenant is a servicemember.
  await expect(page.getByRole('heading', { name: /under a hold/i })).toBeVisible()
  await expect(page.getByText(/default judgment needs the affidavit/i)).toBeVisible()
})

test('a manager without the protected-lift permission can place a hold but not take it off', async ({
  page,
}) => {
  const { property, lease } = await seedTenancy()
  const owner = await seedStaff({ roleKey: 'owner', propertyId: property.id })
  const junior = await seedUnprivilegedManager(property.id)

  await prisma.leaseHold.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      type: 'BANKRUPTCY',
      reason: 'Chapter 13 filed; stay in force.',
      placedByStaffId: owner.id,
    },
  })

  await signIn(page, junior)
  await page.goto(`/leases/${lease.id}`)

  // They SEE it — that a tenancy is held is operationally important to
  // anyone reading the lease.
  await expect(page.getByRole('heading', { name: /under a hold/i })).toBeVisible()

  await page.getByLabel(/^Why this is being lifted/).fill('Client says the case was dismissed.')
  await page.getByRole('button', { name: /Lift the bankruptcy/i }).click()

  // ROLE-01 answers 404 rather than 403 for something outside your reach, so
  // a refused privileged action lands on /no-access rather than rendering an
  // error beside the form.
  await page.waitForURL(/\/no-access/)
  expect(
    await prisma.leaseHold.count({ where: { leaseId: lease.id, liftedAt: null } }),
  ).toBe(1)
})

test('lifting keeps the row and records why, so the history survives', async ({ page }) => {
  const { property, lease } = await seedTenancy()
  const staff = await seedStaff({ roleKey: 'owner', propertyId: property.id })
  await prisma.leaseHold.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      type: 'DISPUTE',
      reason: 'Tenant disputes the March water rebill.',
      placedByStaffId: staff.id,
    },
  })

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page
    .getByLabel(/^Why this is being lifted/)
    .fill('Rebill corrected and credited; tenant agrees the balance.')
  await page.getByRole('button', { name: /Lift the balance disputed/i }).click()

  await expect(page.getByRole('heading', { name: /under a hold/i })).toHaveCount(0)
  // KEPT, not deleted: "was the hold in force on the day that fee was
  // assessed" is the question this record exists to answer.
  await expect(page.getByText(/1 lifted hold/i)).toBeVisible()

  const row = await prisma.leaseHold.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(row.liftedAt).not.toBeNull()
  expect(row.liftReason).toContain('Rebill corrected')
  expect(row.reason).toBe('Tenant disputes the March water rebill.')
})
