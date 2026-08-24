import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// Confidential safety cases (RISK-04, ROLE-05; R-091).
//
// The validation and the wording of the locksmith's note are proved directly
// in packages/core/confidential/confidential.test.ts. What only a browser can
// prove is the thing the whole item is: that a manager — who can do almost
// everything else in this product — cannot see that a case exists, anywhere,
// while the operational consequence of it is perfectly visible to them
// because it has to be.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []

/// SCOPED TO ONE LEGAL ENTITY, ALWAYS. `route-boundaries.spec.ts` records why
/// at length: a portfolio-wide fixture in a suite sharing one database is a
/// candidate for every OTHER spec running concurrently, and R-037c spent a
/// session closing exactly that bleed. It is also what makes the 404 test
/// below mean anything - a second owner has to be a real, working owner of
/// their own properties, not one with an empty scope who never gets past the
/// shell.
async function createStaff(roleKey: 'owner' | 'manager', legalEntityId: string) {
  const unique = randomUUID().slice(0, 8)
  const email = `conf-${roleKey}-${unique}@example.test`
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

async function seedLease() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Conf LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Conf House-${unique}`,
      addressLine1: '4 Quiet Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Jane',
      lastName: `Survivor-${unique}`,
      email: `jane-${unique}@example.test`,
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
      rentCents: 165_000,
      depositCents: 165_000,
      rentDueDay: 1,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  // A code the restricted party may well know. Retiring it is half of what
  // "order the re-key" does.
  await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      label: 'Front lockbox',
      sealedCode: sealSecret('4821', 'access-code'),
      version: 1,
    },
  })
  return { entity, property, unit, lease, tenant, unique }
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
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('opens a case, orders the re-key, and retires the codes on file', async ({ page }) => {
  const seed = await seedLease()
  const { lease, unit, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)

  await page.getByText('Open a confidential case').click()
  await page
    .getByLabel('What is going on')
    .fill('Tenant reported an incident and asked for the locks to be changed today.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByLabel('What you were shown').selectOption('PROTECTIVE_ORDER')
  await page.getByLabel('Date you were shown it').fill('2026-08-20')
  await page.getByRole('button', { name: 'Open the case' }).click()

  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  // `toHaveValue` on the field, NOT `getByText` on the summary. React
  // server-renders a `defaultValue` textarea with its text as CHILDREN and
  // moves it to the `value` property on hydration, so a text assertion here
  // passes or fails depending on which side of hydration it lands - it won
  // for one run and lost the next when an unrelated fixture change shifted
  // the timing. Exactly the race CLAUDE.md records, arriving from the other
  // direction.
  await expect(page.getByLabel('What is going on')).toHaveValue(
    /Tenant reported an incident/,
  )

  await page
    .getByLabel('Who the locksmith should ring if anybody else asks')
    .fill('Sam Rivera on 555-0100')
  await page.getByRole('button', { name: 'Order the re-key and retire the codes' }).click()
  await expect(page.getByText('Re-key ordered as work order')).toBeVisible()

  const found = await prisma.confidentialCase.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { lockChangeWorkOrder: true },
  })
  expect(found.status).toBe('OPEN')
  expect(found.documentationType).toBe('PROTECTIVE_ORDER')
  expect(found.documentationSeenByStaffId).toBe(owner.id)
  expect(found.lockChangeWorkOrder?.priority).toBe('URGENT')

  // ==========================================================================
  // The work order is an ordinary re-key. Nothing on it says why.
  // ==========================================================================
  const job = found.lockChangeWorkOrder!
  const jobText = `${job.scope} ${job.restrictedPartyNote}`.toLowerCase()
  for (const word of ['violence', 'abuse', 'assault', 'protective', 'restraining', 'confidential']) {
    expect(jobText, word).not.toContain(word)
  }
  // Names who MAY be given keys, never who may not.
  expect(job.restrictedPartyNote).toContain(`Jane Survivor-${unique}`)
  expect(job.restrictedPartyNote).not.toContain(`Sam Ex-${unique}`)

  // The lockbox code on file is no longer current.
  const codes = await prisma.accessCode.findMany({ where: { unitId: unit.id } })
  expect(codes).toHaveLength(1)
  expect(codes[0]!.effectiveTo).not.toBeNull()

  // ==========================================================================
  // The audit trail records that it happened and nothing about what it says.
  // AuditLog is what `audit.read` exists to expose broadly; a trail quoting
  // the record it protects has moved the secret rather than kept it.
  // ==========================================================================
  const entries = await prisma.auditLog.findMany({
    where: { entityType: 'ConfidentialCase', entityId: found.id },
  })
  expect(entries.map((e) => e.action).sort()).toEqual([
    'confidential.case_opened',
    'confidential.codes_retired',
    'confidential.lock_change_ordered',
  ])
  const payloads = JSON.stringify(entries.map((e) => ({ after: e.after, reason: e.reason })))
  expect(payloads).not.toContain('Tenant reported an incident')
  expect(payloads).not.toContain(`Sam Ex-${unique}`)
  expect(payloads).not.toContain('PROTECTIVE_ORDER')
})

test('a manager cannot see the case anywhere, but can see the job it created', async ({
  page,
  context,
}) => {
  const seed = await seedLease()
  const { lease, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)
  const manager = await createStaff('manager', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page.getByLabel('What is going on').fill('Restricted. Nobody else should read this.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByRole('button', { name: 'Open the case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  const caseUrl = page.url()
  await page
    .getByLabel('Who the locksmith should ring if anybody else asks')
    .fill('Sam Rivera on 555-0100')
  await page.getByRole('button', { name: 'Order the re-key and retire the codes' }).click()
  await expect(page.getByText('Re-key ordered as work order')).toBeVisible()

  const managerPage = await context.newPage()
  try {
    const octet = () => Math.floor(Math.random() * 254) + 1
    await managerPage.setExtraHTTPHeaders({
      'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
    })
    await signIn(managerPage, manager)

    // Not in the navigation.
    await expect(
      managerPage.getByRole('navigation').getByRole('link', { name: 'Confidential' }),
    ).toHaveCount(0)

    // Not on the tenancy — no panel, no heading, no count. Not a disabled
    // control and not an explanation, both of which would announce that the
    // feature applies here.
    await managerPage.goto(`/leases/${lease.id}`)
    await expect(managerPage.getByText('Confidential case')).toHaveCount(0)
    await expect(managerPage.getByText('Open a confidential case')).toHaveCount(0)

    // Not by URL, in either direction. The register and the case both send
    // them to /no-access, which names the missing permission and nothing
    // else — the same answer for a real id and for a made-up one, so it
    // confirms nothing about what is there.
    await managerPage.goto('/confidential')
    await expect(managerPage).toHaveURL(/\/no-access\?permission=confidential\.read/)
    await managerPage.goto(caseUrl)
    await expect(managerPage).toHaveURL(/\/no-access\?permission=confidential\.read/)
    await managerPage.goto('/confidential/definitelynotarealcaseid')
    await expect(managerPage).toHaveURL(/\/no-access\?permission=confidential\.read/)

    // ======================================================================
    // But the job IS theirs to see, and has to be: somebody has to dispatch
    // a locksmith. What they cannot learn from it is why.
    // ======================================================================
    const workOrder = await prisma.workOrder.findFirstOrThrow({
      where: { unitId: lease.unitId, restrictedPartyNote: { not: null } },
    })
    await managerPage.goto(`/workorders/${workOrder.id}`)
    await expect(managerPage.getByText('Re-key or replace all exterior locks')).toBeVisible()
    await expect(managerPage.getByText(`Sam Ex-${unique}`)).toHaveCount(0)
    await expect(managerPage.getByText('Restricted. Nobody else should read this.')).toHaveCount(0)
  } finally {
    await managerPage.close()
  }
})

test('an owner outside the property gets a 404 on the case, never a 403', async ({ page }) => {
  const seed = await seedLease()
  const { lease, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page.getByLabel('What is going on').fill(`Scoping check ${unique}.`)
  await page.getByRole('button', { name: 'Open the case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  const caseId = page.url().split('/').pop()!

  // ROLE-01, and it matters more here than anywhere else it applies: a 403
  // on a case id confirms a case with that id exists, which is the one fact
  // this whole feature is built to withhold. A scoped owner is the actor who
  // holds the permission and not the property.
  const otherSeed = await seedLease()
  const otherOwner = await createStaff('owner', otherSeed.entity.id)

  const scopedPage = await page.context().newPage()
  try {
    const octet = () => Math.floor(Math.random() * 254) + 1
    await scopedPage.setExtraHTTPHeaders({
      'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
    })
    await signIn(scopedPage, otherOwner)
    const response = await scopedPage.goto(`/confidential/${caseId}`)
    expect(response?.status()).toBe(404)
  } finally {
    await scopedPage.close()
  }
})
