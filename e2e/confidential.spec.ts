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

async function seedLease({ withCoTenant = false } = {}) {
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
  // R-091b's bifurcation acts on a restricted party who is ON the lease, so
  // that path needs a second occupant. Off by default: every other test here
  // is about a single-occupant tenancy and a co-tenant would change what the
  // locksmith's note says.
  let coTenant: { id: string; firstName: string; lastName: string } | null = null
  if (withCoTenant) {
    coTenant = await prisma.tenant.create({
      data: {
        firstName: 'Sam',
        lastName: `Ex-${unique}`,
        email: `sam-${unique}@example.test`,
        phone: uniquePhone(),
      },
    })
    tenantIds.push(coTenant.id)
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: coTenant.id, isPrimary: false },
    })
  }
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
  return { entity, property, unit, lease, tenant, coTenant, unique }
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

test('the re-key kills the door codes and hands the survivor a new one (R-091c)', async ({
  page,
}) => {
  const seed = await seedLease({ withCoTenant: true })
  const { lease, unit, coTenant, tenant, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)

  // A smart lock, and a live door code each. R-091 could only retire the
  // RECORD of a code; a door code is the lock itself, so the restricted
  // party kept working access until the locksmith arrived.
  const lock = await prisma.smartLock.create({
    data: { unitId: unit.id, externalId: `dev-conf-${unique}`, label: 'Front door keypad' },
  })
  const codeFor = (tenantId: string) =>
    prisma.tenantLockCode.create({
      data: {
        smartLockId: lock.id,
        leaseId: lease.id,
        tenantId,
        providerRef: `ref-${tenantId.slice(-8)}`,
        sealedCode: 'sealed-placeholder',
        issuedByStaffId: owner.id,
      },
    })
  const survivorCode = await codeFor(tenant.id)
  const restrictedCode = await codeFor(coTenant!.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page.getByLabel('What is going on').fill('Locks need changing today.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByRole('button', { name: 'Open the confidential case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  await page.getByLabel('Are they on this tenancy?').selectOption(coTenant!.id)
  await page.getByRole('button', { name: 'Save this case' }).click()
  await expect(page.getByText('Case updated.')).toBeVisible()

  await page
    .getByLabel('Who the locksmith should ring if anybody else asks')
    .fill('Sam Rivera on 555-0100')
  await page.getByRole('button', { name: 'Order the re-key and retire the codes' }).click()
  await expect(page.getByText('Re-key ordered as work order')).toBeVisible()

  // BOTH old codes die, not just the restricted party's: households share
  // codes, and somebody told the survivor's code walks in on the survivor's
  // code. This is the digital half of changing the locks.
  for (const old of [survivorCode, restrictedCode]) {
    const after = await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: old.id } })
    expect(after.revokedAt).not.toBeNull()
    expect(after.revokedReason).toBe('The locks are being changed.')
  }

  // And the survivor is not left locked out of her own home - a replacement
  // is minted and shown once, right here, to the person who may have her on
  // the phone.
  const live = await prisma.tenantLockCode.findMany({
    where: { leaseId: lease.id, revokedAt: null },
  })
  expect(live).toHaveLength(1)
  expect(live[0]!.tenantId).toBe(tenant.id)
  // Scoped to the panel: the case-details form above lists every tenant in
  // its "Are they on this tenancy?" select, so an unscoped name match finds
  // both people twice over.
  const lockPanel = page.getByRole('region', { name: 'Locks and access codes' })
  await expect(lockPanel.getByText('New door codes')).toBeVisible()
  await expect(lockPanel.getByText(`Jane Survivor-${unique}`)).toBeVisible()
  // The restricted party gets nothing, and is not named on this panel.
  await expect(lockPanel.getByText(`Sam Ex-${unique}`)).toHaveCount(0)

  // The case-side audit counts, and never says who (D-107).
  const retired = await prisma.auditLog.findFirstOrThrow({
    where: {
      entityType: 'ConfidentialCase',
      action: 'confidential.door_codes_reissued',
      propertyId: seed.property.id,
    },
  })
  expect(retired.after).toMatchObject({ doorCodesReissued: 1, doorCodesStranded: 0 })
  expect(JSON.stringify(retired.after)).not.toContain(`Sam Ex-${unique}`)
  expect(JSON.stringify(retired.after)).not.toContain(`Jane Survivor-${unique}`)

  // The lease-side entries are ordinary and say nothing about why.
  const leaseEntries = await prisma.auditLog.findMany({
    where: { entityType: 'Lease', entityId: lease.id },
  })
  const payloads = JSON.stringify(leaseEntries)
  expect(payloads).not.toContain('confidential')
  expect(leaseEntries.map((entry) => entry.reason)).toContain('The locks are being changed.')
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
  await page.getByRole('button', { name: 'Open the confidential case' }).click()

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
  await page.getByRole('button', { name: 'Open the confidential case' }).click()
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
  await page.getByRole('button', { name: 'Open the confidential case' }).click()
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

// ===========================================================================
// R-091b — the statutory right, and the removal.
//
// The arithmetic and every refusal branch are proved in
// packages/core/confidential/confidential.test.ts. What only a browser proves
// is the half that is about disclosure: that ending a tenancy on a statutory
// safety ground leaves the TENANCY showing an ordinary tenant-given notice,
// and that taking somebody off a lease without their signature leaves a
// perfectly readable amendment that says only that a statute excused it.
// ===========================================================================

test('records the statutory early termination, and the tenancy shows only a tenant notice', async ({
  page,
}) => {
  const seed = await seedLease()
  const { lease, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page
    .getByLabel('What is going on')
    .fill('Tenant asked what their options are for leaving before the term ends.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByRole('button', { name: 'Open the confidential case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  const caseUrl = page.url()

  const panel = page.getByRole('region', { name: 'Ending the tenancy early' })

  // Nothing was recorded about what anybody was shown, and the statutory
  // right is the one thing in this whole feature that turns on it (D-108).
  await panel.getByLabel('Date they gave written notice').fill('2026-08-20')
  await panel.getByRole('button', { name: 'Record the early termination' }).click()
  await expect(page.getByText('The statutory right is the one thing')).toBeVisible()
  expect((await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt).toBeNull()

  // A class Texas does not accept for it, either. §92.016 turns on a
  // protective order and §92.0161 on a provider's documentation; a police
  // report on its own is neither, and the seeded rule itemises exactly that.
  await page.getByLabel('What you were shown').selectOption('POLICE_REPORT')
  await page.getByLabel('Date you were shown it').fill('2026-08-19')
  await page.getByRole('button', { name: 'Save this case' }).click()
  await expect(page.getByText('Case updated.')).toBeVisible()
  await panel.getByLabel('Date they gave written notice').fill('2026-08-20')
  await panel.getByRole('button', { name: 'Record the early termination' }).click()
  await expect(page.getByText('not a class this state accepts')).toBeVisible()

  await page.getByLabel('What you were shown').selectOption('PROTECTIVE_ORDER')
  await page.getByRole('button', { name: 'Save this case' }).click()
  await expect(page.getByText('Case updated.')).toBeVisible()

  await panel.getByLabel('Date they gave written notice').fill('2026-08-20')
  await panel
    .getByLabel('Where to send the deposit disposition')
    .fill('12 Elsewhere Street, Houston TX')
  await panel.getByRole('button', { name: 'Record the early termination' }).click()
  // TX's seeded rule: 30 days from the day notice was delivered. Not the
  // state's `noticeToVacateDays`, which this path never consults. The
  // arithmetic is asserted against the alert, which is the only place the
  // number and the day count appear together.
  await expect(page.getByText('19 Sept 2026 — 30 days from the notice')).toBeVisible()

  // ==========================================================================
  // WHAT THE TENANCY SHOWS. R-066's ordinary tenant-given notice and nothing
  // else - no basis column, because a `Lease` column naming this one would be
  // readable by everybody holding `lease.read` and would be the disclosure
  // (D-107). R-085's SCRA writes one and is right to: being a servicemember
  // is not a secret.
  // ==========================================================================
  const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(after.noticeGivenBy).toBe('TENANT')
  expect(after.noticeEffectiveOn?.toISOString().slice(0, 10)).toBe('2026-09-19')
  expect(after.noticeForwardingAddress).toBe('12 Elsewhere Street, Houston TX')
  expect(after.scraTerminationBasis).toBeNull()
  expect(after.terminationReason).toBeNull()

  const leaseEntries = await prisma.auditLog.findMany({
    where: { entityType: 'Lease', entityId: lease.id },
  })
  const leasePayloads = JSON.stringify(leaseEntries)
  expect(leaseEntries.map((e) => e.action)).toContain('lease.notice_given')
  expect(leasePayloads).not.toContain('PROTECTIVE_ORDER')
  expect(leasePayloads).not.toContain('confidential')
  expect(leasePayloads).not.toContain('earlyTermination')

  const found = await prisma.confidentialCase.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(found.earlyTerminationRecordedAt).not.toBeNull()
  const caseEntry = await prisma.auditLog.findFirstOrThrow({
    // Scoped to THIS case. Unscoped, it picks up the other browser project's
    // row from the same shared database - which is what it did.
    where: {
      entityType: 'ConfidentialCase',
      entityId: found.id,
      action: 'confidential.early_termination_recorded',
    },
  })
  expect(caseEntry.after).toEqual({ caseId: found.id })

  // Recorded once. A second one would be a second notice on a tenancy that
  // already has one.
  await page.goto(caseUrl)
  await expect(panel.getByText('The tenancy ends on 19 Sept 2026')).toBeVisible()
  await expect(panel.getByLabel('Date they gave written notice')).toHaveCount(0)
})

test('removes the restricted party without their signature, and the amendment says only that', async ({
  page,
}) => {
  const seed = await seedLease({ withCoTenant: true })
  const { lease, coTenant, unique } = seed
  const owner = await createStaff('owner', seed.entity.id)

  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page
    .getByLabel('What is going on')
    .fill('The other occupant needs to come off the tenancy and will not be signing.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByRole('button', { name: 'Open the confidential case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)

  const panel = page.getByRole('region', { name: 'Taking the restricted party off the tenancy' })
  // The case named them but not as somebody on the lease, so there is nobody
  // here to remove and the panel says so rather than offering the button.
  await expect(panel.getByText('does not name the restricted party')).toBeVisible()

  await page.getByLabel('Are they on this tenancy?').selectOption(coTenant!.id)
  await page.getByRole('button', { name: 'Save this case' }).click()
  await expect(page.getByText('Case updated.')).toBeVisible()

  await panel.getByLabel('Date the removal takes effect').fill('2026-09-01')
  await panel.getByRole('button', { name: 'Send the amendment without their signature' }).click()
  // The panel's own POST-SEND text, not the alert and not the form's prose.
  // The first version of this waited on a sentence the form was already
  // showing before the click, so the query below raced the write and lost -
  // the same "assertion that is already true" CLAUDE.md records for
  // `getByText('active')`.
  await expect(panel.getByText('An amendment was sent as change')).toBeVisible()

  const change = await prisma.leasePartyChange.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { parties: true, envelope: { include: { signers: true } } },
  })
  expect(change.status).toBe('PENDING_SIGNATURE')
  expect(change.unsignedRemovalBasis).toBe('STATUTORY_EXEMPTION')
  expect(change.parties.map((p) => [p.direction, p.tenantId])).toEqual([
    ['OUTGOING', coTenant!.id],
  ])

  // ==========================================================================
  // THE PERSON BEING REMOVED IS NOT A SIGNER, and everybody else still is.
  // That, and the basis column, are the entire mechanical difference from an
  // ordinary change - which is why they share one builder.
  // ==========================================================================
  const signers = change.envelope!.signers
  expect(signers.map((s) => s.tenantId)).toEqual([seed.tenant.id])
  expect(
    await prisma.notification.count({
      where: { recipientId: coTenant!.id, templateKey: 'lease.amendment_sign_invite' },
    }),
  ).toBe(0)

  // ==========================================================================
  // AND WHAT IT SAYS. The reason is a fixed string, because it is printed on
  // a document every signer reads, archived where `document.read` reaches the
  // maintenance tech, and copied into `lease.party_changed`. A free-text box
  // here is an invitation to type the one sentence the wall exists to hold.
  // ==========================================================================
  for (const word of ['violence', 'abuse', 'assault', 'protective', 'restraining', 'confidential']) {
    expect(change.reason.toLowerCase(), word).not.toContain(word)
  }
  const startedEntry = await prisma.auditLog.findFirstOrThrow({
    where: { entityType: 'Lease', entityId: lease.id, action: 'lease.party_change_started' },
  })
  expect(JSON.stringify(startedEntry.after)).toContain('STATUTORY_EXEMPTION')
  expect(JSON.stringify(startedEntry).toLowerCase()).not.toContain('confidential')

  // It is an ordinary change of occupants on the tenancy, visible to anybody
  // who can read the lease - which is the point. Its consequences cannot be
  // hidden; its reason can.
  await page.goto(`/leases/${lease.id}`)
  const leasePanel = page.getByRole('region', { name: 'Roommate changes and assignment' })
  await expect(leasePanel.getByText('under a statutory right')).toBeVisible()
})
