import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// The Servicemembers Civil Relief Act (RISK-12, R-085).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES: THE JUDGMENT GATE, AND THE HOLD THAT PLACES
// ITSELF.
//
// §3955's date arithmetic is pure and unit-tested in packages/core/scra, and
// which search the affidavit reads is proved against a database in
// lib/scra/scra.test.ts. Two things live only here:
//
//   * A DEFAULT judgment is refused when no DMDC search is on file, and a
//     CONTESTED one is not gated at all. That split is the whole of §3931 and
//     it runs through a form field a PM fills in.
//   * Recording an active-duty certificate places the R-084 SCRA hold by
//     itself. It is the one automatic hold in the product, and if it ever
//     stops firing, nothing anywhere goes red except this.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `SCRA LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `SCRA House-${stamp}`,
      addressLine1: '7 Garrison Road',
      city: 'Killeen',
      state: 'TX',
      postalCode: '76541',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Casey', lastName: `Servicemember-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { property, unit, lease, tenant }
}

/// PORTFOLIO-WIDE, and MFA-enrolled. `/evictions/[id]` opens with an
/// unscoped `requirePermission('eviction.manage')`, so a property-scoped
/// grant sends the person whose job this is to /no-access — the trap
/// fee-waiver.spec.ts and lease-holds.spec.ts both already record.
async function seedOwner() {
  const email = `scra-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'SCRA Owner',
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
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, secret }
}

/// A case already at COURT, because the ladder is NOTICE → FILING → COURT →
/// JUDGMENT and the page only ever offers the ONE next rung. Seeding at
/// FILING offers "record the court date", not the judgment — which is not
/// the stage this file is about. The cure gate (R-083) is exercised by
/// evictions.spec.ts and is deliberately stepped over here.
async function openCaseAwaitingJudgment(args: {
  propertyId: string
  unitId: string
  leaseId: string
  staffId: string
}) {
  return prisma.evictionCase.create({
    data: {
      propertyId: args.propertyId,
      unitId: args.unitId,
      leaseId: args.leaseId,
      openedByStaffId: args.staffId,
      stage: 'COURT',
      filedOn: new Date('2026-08-03T00:00:00.000Z'),
      courtDate: new Date('2026-09-08T14:00:00.000Z'),
      notes: 'Rent unpaid since June.',
    },
  })
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

// Login is rate-limited per IP (R-003); without a distinct forwarded-for the
// later tests throttle and read as a broken page.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // ScraLookup and LeaseHold both point at StaffUser with Restrict, and every
  // action here writes an append-only audit row — nothing is deleted.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { status: 'ENDED' },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('THE GATE: a default judgment is refused with no DMDC search on file', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseAwaitingJudgment({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
  })

  await signIn(page, staff)
  await page.goto(`/evictions/${evictionCase.id}`)

  // Said BEFORE the attempt, not only after it — the same posture the cure
  // clock takes one section up.
  await expect(page.getByText(/needs the §3931 military-service affidavit/i).first()).toBeVisible()

  await page.getByLabel('Date of judgment').fill('2026-09-10')
  await page.getByRole('radio', { name: /default judgment/i }).check()
  await page.getByRole('button', { name: 'Record the judgment' }).click()

  await expect(page.getByText(/can be reopened on the servicemember/i)).toBeVisible()
  const after = await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })
  expect(after.stage).toBe('COURT')
  expect(after.judgmentOn).toBeNull()
})

test('a CONTESTED judgment is not gated at all — §3931 simply does not apply', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseAwaitingJudgment({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
  })

  await signIn(page, staff)
  await page.goto(`/evictions/${evictionCase.id}`)

  await page.getByLabel('Date of judgment').fill('2026-09-10')
  await page.getByRole('radio', { name: /contested/i }).check()
  await page.getByRole('button', { name: 'Record the judgment' }).click()

  // The NEXT rung's button, which can only exist once this one landed.
  //
  // NOT `getByText('Judgment entered')`, which is the stage label and looks
  // like the obvious assertion: `getByText` is a case-insensitive SUBSTRING
  // match, and the affidavit prompt already on this page says "A judgment
  // entered without one can be reopened…". So it resolved instantly against
  // a warning, the database check ran before the mutation had landed, and
  // the failure read as "the action did not work" when the assertion was
  // simply never waiting. Same family as the `/leases/new` trap in
  // CLAUDE.md: an assertion that is already true tests nothing.
  await expect(page.getByRole('button', { name: 'Record the writ' })).toBeVisible()
  const after = await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })
  expect(after.stage).toBe('JUDGMENT')
  expect(after.tenantAppeared).toBe(true)
})

test('the answer to "did they appear" is required — an unticked radio is not a "no"', async ({
  page,
}) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseAwaitingJudgment({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
  })

  await signIn(page, staff)
  await page.goto(`/evictions/${evictionCase.id}`)

  await page.getByLabel('Date of judgment').fill('2026-09-10')
  await page.getByRole('button', { name: 'Record the judgment' }).click()

  await expect(page.getByText(/Did the tenant appear\?/).first()).toBeVisible()
  expect(
    (await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })).stage,
  ).toBe('COURT')
})

test('recording an active-duty certificate places the SCRA hold by itself', async ({ page }) => {
  const { property, lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await expect(page.getByRole('heading', { name: /under a hold/i })).toHaveCount(0)

  await page.getByLabel('Who was searched for').selectOption(tenant.id)
  await page.getByLabel('Date the search was run').fill('2026-08-15')
  await page.getByLabel('What the certificate says').selectOption('in_service')
  // The consequence is stated before the button is pressed.
  await expect(page.getByText(/places an SCRA hold on the tenancy automatically/i)).toBeVisible()
  await page.getByLabel('Certificate reference').fill('DMDC-2026-88214')
  await page.getByRole('button', { name: 'Record this search' }).click()

  // THE ASSERTION THIS TEST EXISTS FOR.
  await expect(page.getByRole('heading', { name: /under a hold/i })).toBeVisible()
  await expect(page.getByText(/default judgment needs the affidavit/i)).toBeVisible()

  const hold = await prisma.leaseHold.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'MILITARY_SCRA', liftedAt: null },
  })
  // The reason names the document it came from, which is more than most
  // typed ones manage.
  expect(hold.reason).toContain('DMDC-2026-88214')
  expect(hold.reason).toContain('2026-08-15')
})

test('§3955: the effective date is computed from the statute, not typed', async ({ page }) => {
  const { lease } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Which limb of §3955(b)').selectOption('pcs_or_deployment')
  await expect(page.getByText(/Deployment orders must show a period of 90 days or more/i)).toBeVisible()
  await page.getByLabel('Date the notice and orders were delivered').fill('2026-08-01')
  await page.getByLabel('The orders').setInputFiles({
    name: 'pcs-orders.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 simulated orders'),
  })
  await page.getByRole('button', { name: 'Record the termination' }).click()

  // Rent due on the 1st, notice delivered 1 August: the next payment due
  // AFTER that date is 1 September, and 30 days later is 1 October. Nobody
  // typed that date.
  //
  // Asserted against the PANEL, not the action's success notice. Recording
  // the termination swaps the form for the recorded state, so the live
  // region carrying the notice is unmounted in the same pass that would have
  // populated it — the self-replacing-panel trap `closeCase` documents at
  // length. What survives is the durable render, which is the better thing
  // to be asserting anyway.
  await expect(page.getByText(/The tenancy ends 2026-10-01/)).toBeVisible()

  const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(after.scraTerminationBasis).toBe('PCS_OR_DEPLOYMENT')
  expect(after.noticeGivenBy).toBe('TENANT')
  expect(after.noticeEffectiveOn?.toISOString().slice(0, 10)).toBe('2026-10-01')
})

test('§3955 is refused without the orders attached', async ({ page }) => {
  const { lease } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Which limb of §3955(b)').selectOption('entered_service')
  await page.getByLabel('Date the notice and orders were delivered').fill('2026-08-01')
  // The file input is `required`, so the browser blocks the submit before the
  // server ever sees it — which is the control working. Removing the
  // attribute is how we reach the SERVER's own refusal, and the server's is
  // the one that matters.
  await page.evaluate(() => document.getElementById('scra-orders')?.removeAttribute('required'))
  await page.getByRole('button', { name: 'Record the termination' }).click()

  await expect(page.getByText(/§3955\(c\)\(1\) requires the notice to be accompanied/i)).toBeVisible()
  expect(
    (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).scraTerminationBasis,
  ).toBeNull()
})
