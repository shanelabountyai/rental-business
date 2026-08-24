import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone, uniqueClientHeaders } from './fixtures.ts'

// GOLDEN PATH 3 — the confidential path (Demo checkpoint 3, D-28).
//
// ==========================================================================
// THIS SPEC EXISTS BECAUSE EVERY OTHER TEST OF THESE ITEMS WAS WRITTEN FROM
// INSIDE ITS OWN SEAM.
//
// Milestone 8 closed with no demo checkpoint of its own - twelve risk items
// shipped without an end-to-end gate, which is the exact condition D-28
// exists to prevent. Its four original findings were all seam defects: a
// status added to an enum and not to the two lists that read it, a lifecycle
// ending in one table and not the other. Each was invisible from inside the
// item that introduced it and obvious the moment somebody followed one case
// through.
//
// So this follows ONE tenancy across six items - R-091, R-091b, R-091c,
// R-094b, R-092, R-097c - every one of which independently promises that
// something does not leak, and asserts the promises against each OTHER
// surface rather than against its own.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []

async function createStaff(roleKey: 'owner' | 'manager', legalEntityId: string) {
  const unique = randomUUID().slice(0, 8)
  const email = `gp3-${roleKey}-${unique}@example.test`
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

test('Golden Path 3: what the other surfaces show', async ({ page, browser }) => {
  // Longer than the default: this walks six items end to end and is the
  // acceptance gate for a whole milestone, not a unit of one.
  test.setTimeout(180_000)

  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `GP3 LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `GP3 House-${unique}`,
      addressLine1: '8 Checkpoint Close',
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
  const lock = await prisma.smartLock.create({
    data: { unitId: unit.id, externalId: `dev-gp3-${unique}`, label: 'Front door keypad' },
  })

  const survivor = await prisma.tenant.create({
    data: {
      firstName: 'Jane',
      lastName: `Survivor-${unique}`,
      email: `jane-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  const restricted = await prisma.tenant.create({
    data: {
      firstName: 'Sam',
      lastName: `Ex-${unique}`,
      email: `sam-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(survivor.id, restricted.id)

  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date('2026-12-31T00:00:00Z'),
      rentCents: 165_000,
      depositCents: 0,
      rentDueDay: 1,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: survivor.id, isPrimary: true },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: restricted.id, isPrimary: false },
  })
  // A door code each, and an access code on file - the state a real tenancy
  // is in before any of this starts.
  const owner = await createStaff('owner', entity.id)
  const doorCodes = await Promise.all(
    [survivor.id, restricted.id].map((tenantId) =>
      prisma.tenantLockCode.create({
        data: {
          smartLockId: lock.id,
          leaseId: lease.id,
          tenantId,
          providerRef: `ref-${tenantId.slice(-8)}`,
          sealedCode: 'sealed-placeholder',
          issuedByStaffId: owner.id,
        },
      }),
    ),
  )
  await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      label: 'Front lockbox',
      sealedCode: sealSecret('4821', 'access-code'),
      version: 1,
    },
  })

  // ------------------------------------------------------------------
  // R-091: the case, and R-091c: the re-key that now reaches the lock
  // ------------------------------------------------------------------
  await signIn(page, owner)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a confidential case').click()
  await page
    .getByLabel('What is going on')
    .fill('Tenant asked for the locks changed and the other occupant removed.')
  await page.getByLabel('Name of the restricted party').fill(`Sam Ex-${unique}`)
  await page.getByLabel('What you were shown').selectOption('PROTECTIVE_ORDER')
  await page.getByLabel('Date you were shown it').fill('2026-08-20')
  await page.getByRole('button', { name: 'Open the case' }).click()
  await page.waitForURL(/\/confidential\/[a-z0-9]+$/)
  const caseUrl = page.url()

  await page.getByLabel('Are they on this tenancy?').selectOption(restricted.id)
  await page.getByRole('button', { name: 'Save this case' }).click()
  await expect(page.getByText('Case updated.')).toBeVisible()

  await page
    .getByLabel('Who the locksmith should ring if anybody else asks')
    .fill('Sam Rivera on 555-0100')
  await page.getByRole('button', { name: 'Order the re-key and retire the codes' }).click()
  await expect(page.getByText('Re-key ordered as work order')).toBeVisible()

  // Both door codes die; the survivor gets one back. R-091c across R-094b.
  for (const code of doorCodes) {
    const after = await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: code.id } })
    expect(after.revokedAt, 'every door code on the unit is revoked').not.toBeNull()
  }
  const live = await prisma.tenantLockCode.findMany({
    where: { leaseId: lease.id, revokedAt: null },
  })
  expect(live.map((row) => row.tenantId)).toEqual([survivor.id])

  // ------------------------------------------------------------------
  // R-091b: removed without their signature
  // ------------------------------------------------------------------
  const removePanel = page.getByRole('region', {
    name: 'Taking the restricted party off the tenancy',
  })
  await removePanel.getByLabel('Date the removal takes effect').fill('2026-09-01')
  await removePanel
    .getByRole('button', { name: 'Send the amendment without their signature' })
    .click()
  await expect(removePanel.getByText('An amendment was sent as change')).toBeVisible()

  const change = await prisma.leasePartyChange.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { envelope: { include: { signers: true } } },
  })
  expect(change.unsignedRemovalBasis).toBe('STATUTORY_EXEMPTION')
  expect(
    change.envelope!.signers.map((signer) => signer.tenantId),
    'the restricted party is not asked to sign',
  ).toEqual([survivor.id])

  // ------------------------------------------------------------------
  // R-091b: the statutory early termination
  // ------------------------------------------------------------------
  const endPanel = page.getByRole('region', { name: 'Ending the tenancy early' })
  await endPanel.getByLabel('Date they gave written notice').fill('2026-08-20')
  await endPanel.getByRole('button', { name: 'Record the early termination' }).click()
  await expect(page.getByText('2026-09-19 — 30 days from the notice')).toBeVisible()

  const leaseAfter = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(leaseAfter.noticeGivenBy).toBe('TENANT')
  expect(leaseAfter.scraTerminationBasis, 'no basis column on the tenancy').toBeNull()
  expect(leaseAfter.terminationReason).toBeNull()

  // WHAT MUST NOT LEAK IS THE CASE, NOT THE PERSON. The first version of
  // this list included the restricted party's own name, and the walk
  // immediately failed on the lease page - correctly, and on the assertion
  // rather than on the product. Sam is an occupant of the unit and an
  // outgoing party on a lease amendment; both are facts a manager running
  // the property can obviously see, and R-091b's design is precisely that
  // the CHANGE is visible while its REASON is not (D-112's fixed string is
  // what makes that true). Conflating the person with the case would have
  // made this spec demand something the product must not do: hide a lease
  // party from the person managing the lease.
  const secrets = [
    'Tenant asked for the locks changed',
    'PROTECTIVE_ORDER',
    'Protective or restraining order',
  ]

  // ==================================================================
  // THE GATE. Five other surfaces, each a different item's promise,
  // each asserted from OUTSIDE the item that made it.
  // ==================================================================

  // 1. THE AUDIT TRAIL (R-091, D-107). The table `audit.read` exposes
  //    broadly. It carries the case id and never the content.
  const leaseAudit = await prisma.auditLog.findMany({
    where: { entityType: 'Lease', entityId: lease.id },
  })
  const leaseAuditText = JSON.stringify(leaseAudit)
  for (const secret of secrets) {
    expect(leaseAuditText, `lease audit must not carry: ${secret}`).not.toContain(secret)
  }
  expect(leaseAuditText.toLowerCase()).not.toContain('confidential')

  // 2. THE WORK ORDER (R-091, D-109). It has to exist and be dispatchable;
  //    what must never leak is why.
  const rekey = await prisma.workOrder.findFirstOrThrow({
    where: { propertyId: property.id, priority: 'URGENT' },
  })
  const jobText = `${rekey.scope} ${rekey.restrictedPartyNote}`.toLowerCase()
  for (const word of ['violence', 'abuse', 'assault', 'protective', 'restraining', 'confidential']) {
    expect(jobText, `the job must not say: ${word}`).not.toContain(word)
  }
  // Names who MAY be given keys, never who may not.
  expect(rekey.restrictedPartyNote).toContain(`Jane Survivor-${unique}`)
  expect(rekey.restrictedPartyNote).not.toContain(`Sam Ex-${unique}`)

  // 3. A MANAGER (R-091, ROLE-05). Can run the property, cannot see the case.
  const manager = await createStaff('manager', entity.id)
  const managerContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const managerPage = await managerContext.newPage()
  try {
    await signIn(managerPage, manager)
    await managerPage.goto(`/workorders/${rekey.id}`)
    // The consequence is visible to them, which is the point of D-109.
    await expect(managerPage.getByText(/Re-key|re-key/).first()).toBeVisible()
    // The case is not. ASSERTED ON THE URL, NOT THE STATUS - R-103's lesson:
    // a manager holds no `confidential.read` at all, so the guard REDIRECTS
    // to /no-access, which returns a perfectly healthy 200 carrying a page
    // that explains itself. A status-only assertion would pass for a page
    // that had rendered the case in full. (The 404 branch is R-091's own
    // spec: an OWNER outside scope, who has the permission and must not be
    // told the case exists.)
    await managerPage.goto(caseUrl)
    await expect(managerPage).toHaveURL(/\/no-access/)
    const refusedPage = await managerPage.content()
    for (const secret of secrets) {
      expect(refusedPage, `the refusal page must not carry: ${secret}`).not.toContain(secret)
    }
    await managerPage.goto(`/leases/${lease.id}`)
    const leasePage = await managerPage.content()
    for (const secret of secrets) {
      expect(leasePage, `the lease page must not carry: ${secret}`).not.toContain(secret)
    }
    // Not even that a case EXISTS: the control that opens one renders only
    // behind `confidential.read`, and its absence is what stops a manager
    // learning the fact by finding the button already used.
    await expect(managerPage.getByText('Open a confidential case')).toHaveCount(0)
    // And the amendment IS visible to them, with its neutral reason - the
    // other half of D-112, asserted from outside the item that made it.
    await expect(managerPage.getByText('under a statutory right')).toBeVisible()
  } finally {
    await managerContext.close()
  }

  // 4. THE HANDOFF PACKET (R-092, D-113). The largest egress in the product.
  await prisma.workOrder.update({
    where: { id: rekey.id },
    data: { status: 'CLOSED', completedAt: new Date(), invoiceCents: 24_000 },
  })
  await page.goto(`/properties/${property.id}`)
  const handoff = page.getByRole('region', { name: 'Sale and acquisition handoff' })
  await handoff.getByRole('button', { name: 'Assemble the handoff packet' }).click()
  await expect(page.getByText('Packet archived')).toBeVisible()
  const packetAudit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: property.id, action: 'property.handoff_packet_archived' },
  })
  // The job IS counted - a buyer sees the maintenance history, including
  // this - and the note behind it is what the source-level test keeps out.
  expect(packetAudit.after).toMatchObject({ vendorJobCount: 1 })

  // 5. THE CALENDAR FEED (R-097c, D-124). It leaves the building furthest.
  await prisma.workOrder.update({
    where: { id: rekey.id },
    data: { status: 'SCHEDULED', completedAt: null, scheduledStart: new Date(Date.now() + 3_600_000) },
  })
  const minted = mintToken('CALENDAR_FEED')
  await prisma.authToken.create({
    data: {
      purpose: 'CALENDAR_FEED',
      tokenHash: minted.tokenHash,
      subjectType: 'StaffUser',
      subjectId: owner.id,
      expiresAt: minted.expiresAt,
    },
  })
  const feed = await page.request.get(`/api/calendar/${minted.token}`)
  expect(feed.status()).toBe(200)
  const ics = await feed.text()
  // The visit is on the calendar, because somebody has to attend it.
  expect(ics).toContain('8 Checkpoint Close')
  // And nothing else about it is.
  for (const secret of [...secrets, `Jane Survivor-${unique}`]) {
    expect(ics, `the calendar must not carry: ${secret}`).not.toContain(secret)
  }
  expect(ics).not.toContain(rekey.restrictedPartyNote!)
})
