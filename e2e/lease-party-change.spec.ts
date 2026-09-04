import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// Roommate changes and lease assignment (RISK-10, R-090).
//
// The validation rules are proved directly in
// packages/core/leases/party-change.test.ts. What only an end-to-end run can
// prove is the thing the whole item turns on: that a change of occupants
// leaves the LEASE untouched - same row, same status, same rent, same
// deposit, same ledger, no disposition opened - while the people on it
// actually change once everybody has signed.
//
// The sign links are minted directly, for the same reason
// `lease-esign.spec.ts` does it: `issueToken` is `server-only` and cannot
// load into Playwright's plain-Node context.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []
const applicantIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const email = `swap-${unique}@example.test`
  const enrolment = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `Swap Manager ${unique}`,
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
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, secret: enrolment.secret }
}

async function makeTenant(first: string, unique: string) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: first,
      lastName: `Swap-${unique}`,
      email: `${first.toLowerCase()}-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  return tenant
}

/// An ACTIVE two-occupant tenancy with a deposit held and a rent charge on
/// the ledger, which is what makes the "nothing moved" assertions mean
/// something.
async function seedLiveLease() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Swap LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Swap House-${unique}`,
      addressLine1: '9 Roommate Row',
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
  const alice = await makeTenant('Alice', unique)
  const bob = await makeTenant('Bob', unique)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date('2026-12-31T00:00:00Z'),
      rentCents: 180_000,
      depositCents: 180_000,
      rentDueDay: 1,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: alice.id, isPrimary: true },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: bob.id } })
  return { entity, property, unit, lease, alice, bob, unique }
}

/// A replacement roommate, screened exactly as any other applicant is.
async function seedApplicant(
  property: { id: string },
  unitId: string,
  unique: string,
  options: { decision: string | null; monthlyIncomeCents?: number } = { decision: 'APPROVED' },
) {
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId,
      status: 'DRAFT',
      rentCents: 180_000,
      availableOn: new Date('2026-01-01'),
    },
  })
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: property.id,
      listingId: listing.id,
      firstName: 'Cara',
      lastName: `Replacement-${unique}`,
      email: `cara-${unique}@example.test`,
      source: 'WALK_IN',
    },
  })
  const application = await prisma.application.create({
    data: { propertyId: property.id, listingId: listing.id, prospectId: prospect.id },
  })
  const applicant = await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: 'Cara',
      lastName: `Replacement-${unique}`,
      email: `cara-${unique}@example.test`,
      phone: uniquePhone(),
      monthlyIncomeCents: options.monthlyIncomeCents ?? 700_000,
    },
  })
  applicantIds.push(applicant.id)
  if (options.decision) {
    await prisma.screeningReport.create({
      data: {
        applicantId: applicant.id,
        providerId: `sim_${randomUUID().slice(0, 8)}`,
        status: 'COMPLETE',
        criteriaVersion: 1,
        creditScore: 720,
        evictionRecordFound: false,
        criminalRecordFound: false,
        decision: options.decision,
        decisionNotes: options.decision === 'APPROVED' ? null : 'Recorded by the fixture.',
        decidedAt: new Date(),
      },
    })
  }
  return applicant
}

async function mintSignLink(signerId: string) {
  const minted = mintToken('LEASE_SIGN')
  await prisma.authToken.create({
    data: {
      purpose: 'LEASE_SIGN',
      tokenHash: minted.tokenHash,
      subjectType: 'LeaseSigner',
      subjectId: signerId,
      expiresAt: minted.expiresAt,
    },
  })
  return minted.token
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
  // Retire, don't delete. LeaseSigner and Document RESTRICT-reference this
  // chain, exactly as lease-esign.spec.ts's own cleanup already documents.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('swaps a roommate on the same lease, with the deposit and the ledger untouched', async ({
  page,
  context,
}) => {
  const staff = await createStaff()
  const { property, unit, lease, alice, bob, unique } = await seedLiveLease()
  const cara = await seedApplicant(property, unit.id, unique)

  // R-094b. A door code each, so completing the amendment can be checked
  // against the thing that actually matters: whether the person leaving can
  // still key in. The rows are written directly - issuing through the UI
  // needs `accesscode.issue`, which is privileged, and this spec signs in
  // plainly. That the DEVICE stops honouring a revoked code is proved in
  // apps/web/lib/locks/tenant-codes.test.ts, which can reach the simulator.
  const lock = await prisma.smartLock.create({
    data: { unitId: unit.id, externalId: `dev-${unique}`, label: 'Front door keypad' },
  })
  const codeFor = async (tenantId: string) =>
    prisma.tenantLockCode.create({
      data: {
        smartLockId: lock.id,
        leaseId: lease.id,
        tenantId,
        providerRef: `ref-${tenantId.slice(-8)}`,
        sealedCode: 'sealed-placeholder',
        issuedByStaffId: staff.id,
      },
    })
  const aliceCode = await codeFor(alice.id)
  const bobCode = await codeFor(bob.id)

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  const panel = page.getByRole('region', { name: 'Roommate changes and assignment' })
  await panel.getByLabel(`Bob Swap-${unique} is leaving`).check()
  await panel.getByLabel(`Cara Replacement-${unique} is joining`).check()
  await panel.getByLabel('The change takes effect on').fill('2026-09-01')
  await panel
    .getByLabel('Why are the occupants changing?')
    .fill('Bob is relocating for work; Cara is taking his room.')
  await panel.getByRole('button', { name: 'Send the amendment to everybody' }).click()

  await expect(page.getByText('Amendment sent to everybody for signature.')).toBeVisible()

  const change = await prisma.leasePartyChange.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { parties: true, envelope: { include: { signers: { orderBy: { order: 'asc' } } } } },
  })
  expect(change.status).toBe('PENDING_SIGNATURE')
  expect(change.envelope?.kind).toBe('AMENDMENT')
  // No template. The amendment's text IS the change - see
  // LeaseEnvelope.templateId's own comment.
  expect(change.envelope?.templateId).toBeNull()

  // Everybody signs: whoever stays, whoever joins, whoever leaves. A release
  // signed only by the person being released is the weakest version of it.
  const signers = change.envelope!.signers
  expect(signers).toHaveLength(3)
  expect(signers.map((s) => s.name)).toEqual([
    `Alice Swap-${unique}`,
    `Cara Replacement-${unique}`,
    `Bob Swap-${unique}`,
  ])

  // The incoming party's Tenant row exists already - they have to be
  // addressable to be sent a link at all - but they are NOT on the lease yet.
  // Non-null: an INCOMING party is always a tenant - a guarantor party
  // (R-165) is never incoming, enforced by its own CHECK constraint.
  const caraTenantId = change.parties.find((p) => p.direction === 'INCOMING')!.tenantId!
  tenantIds.push(caraTenantId)
  expect(
    await prisma.leaseTenant.count({ where: { leaseId: lease.id, tenantId: caraTenantId } }),
  ).toBe(0)
  expect(await prisma.leaseTenant.count({ where: { leaseId: lease.id, tenantId: bob.id } })).toBe(1)

  for (const [index, signer] of signers.entries()) {
    const token = await mintSignLink(signer.id)
    const signerPage = await context.newPage()
    try {
      await signerPage.goto(`/sign/${token}`)
      // A departing roommate is not being told "your lease is ready to sign".
      await expect(
        signerPage.getByRole('link', { name: 'Read the change in full before signing' }),
      ).toBeVisible()
      await signerPage.getByLabel('Type your full legal name').fill(signer.name)
      await signerPage.getByRole('checkbox').check()
      await signerPage.getByRole('button', { name: 'Sign this lease' }).click()
      await expect(
        signerPage.getByText(
          index === signers.length - 1
            ? 'Everybody has now signed, and it is in effect.'
            : 'Still waiting on the remaining signer(s)',
        ),
      ).toBeVisible()
    } finally {
      await signerPage.close()
    }
  }

  // ==========================================================================
  // The whole item, asserted.
  // ==========================================================================
  const after = await prisma.lease.findUniqueOrThrow({
    where: { id: lease.id },
    include: { leaseTenants: true, deposits: true },
  })

  // Same lease row, same status, same money. A renewal would have made a new
  // Lease; this must not, because that is what carries the ledger through.
  expect(after.status).toBe('ACTIVE')
  expect(after.rentCents).toBe(180_000)
  expect(after.depositCents).toBe(180_000)
  expect(after.moveOutAt).toBeNull()
  expect(after.noticeGivenAt).toBeNull()

  // The people changed.
  expect(after.leaseTenants.map((lt) => lt.tenantId).sort()).toEqual(
    [alice.id, caraTenantId].sort(),
  )
  expect(after.leaseTenants.find((lt) => lt.tenantId === alice.id)!.isPrimary).toBe(true)

  // RISK-10's hard rule: no partial mid-tenancy refund, and no disposition
  // opened. Nothing here can pay a departing roommate anything.
  expect(after.deposits).toHaveLength(0)
  // Not one ledger row of any kind. A change of occupants is not a money
  // event, so the absence is total rather than a filter on a refund type.
  expect(await prisma.ledgerEntry.count({ where: { leaseId: lease.id } })).toBe(0)
  expect(await prisma.charge.count({ where: { leaseId: lease.id } })).toBe(0)

  const applied = await prisma.leasePartyChange.findUniqueOrThrow({
    where: { id: change.id },
    include: { envelope: true },
  })
  // R-094b. Killing the departing occupant's portal session was the whole of
  // "they no longer have access" before a lock existed, and it was the
  // smaller half: somebody removed from a lease who can still key in at the
  // front door is the failure the whole item exists to prevent.
  const bobAfter = await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: bobCode.id } })
  expect(bobAfter.revokedAt).not.toBeNull()
  expect(bobAfter.revokedReason).toBe('They came off the tenancy.')
  // Automatic, so nobody to attribute it to - an invented actor is a worse
  // record than an honest absence.
  expect(bobAfter.revokedByStaffId).toBeNull()
  // And the person staying is untouched, which is why codes are per person.
  const aliceAfter = await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: aliceCode.id } })
  expect(aliceAfter.revokedAt).toBeNull()

  expect(applied.status).toBe('COMPLETED')
  expect(applied.appliedAt).not.toBeNull()
  expect(applied.envelope?.executedDocumentId).not.toBeNull()

  // The screening record is what proves the replacement was held to the same
  // criteria as anybody else, and it is pinned to the change (R-088's own
  // precedent).
  expect(change.parties.find((p) => p.direction === 'INCOMING')!.applicantId).toBe(cara.id)

  await page.reload()
  await expect(panel.getByText('Signed by everybody and applied')).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Download the signed amendment' })).toBeVisible()
})

test('refuses a replacement whose screening has not been decided, and refuses to empty the tenancy', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit, lease, unique } = await seedLiveLease()
  await seedApplicant(property, unit.id, unique, { decision: null })

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  const panel = page.getByRole('region', { name: 'Roommate changes and assignment' })
  // An undecided applicant is not offered at all - the picker only carries
  // decided, non-declined screenings.
  await expect(panel.getByLabel(`Cara Replacement-${unique} is joining`)).toHaveCount(0)

  // Everybody out and nobody in is the END of a tenancy, not a change of
  // roommates, and it has its own flow with its own deposit disposition.
  await panel.getByLabel(`Alice Swap-${unique} is leaving`).check()
  await panel.getByLabel(`Bob Swap-${unique} is leaving`).check()
  await panel.getByLabel('The change takes effect on').fill('2026-09-01')
  await panel.getByLabel('Why are the occupants changing?').fill('Both of them are moving out.')
  await panel.getByRole('button', { name: 'Send the amendment to everybody' }).click()

  await expect(panel.getByText('This would leave nobody on the tenancy')).toBeVisible()
  expect(await prisma.leasePartyChange.count({ where: { leaseId: lease.id } })).toBe(0)
})

test('will not take somebody off a running tenancy through the plain Remove button', async ({
  page,
}) => {
  const staff = await createStaff()
  const { lease, unique } = await seedLiveLease()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  // R-090 closed this. Until it did, a roommate could be taken off a live,
  // signed lease with one click: no release, no signature from the people
  // who stay, and nothing at all told to the person leaving.
  const parties = page.getByRole('region', { name: 'Who is on this lease' })
  await parties
    .getByRole('listitem')
    .filter({ hasText: `Bob Swap-${unique}` })
    .getByRole('button', { name: 'Remove' })
    .click()

  await expect(page.getByText('Taking somebody off a live tenancy is a change of occupants')).toBeVisible()
  expect(await prisma.leaseTenant.count({ where: { leaseId: lease.id } })).toBe(2)
})

test('withdraws an amendment that is out for signature, and the lease is untouched', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit, lease, unique } = await seedLiveLease()
  await seedApplicant(property, unit.id, unique)

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  const panel = page.getByRole('region', { name: 'Roommate changes and assignment' })
  await panel.getByLabel(`Bob Swap-${unique} is leaving`).check()
  await panel.getByLabel(`Cara Replacement-${unique} is joining`).check()
  await panel.getByLabel('The change takes effect on').fill('2026-09-01')
  await panel.getByLabel('Why are the occupants changing?').fill('Bob is relocating for work.')
  await panel.getByRole('button', { name: 'Send the amendment to everybody' }).click()
  await expect(page.getByText('Amendment sent to everybody for signature.')).toBeVisible()

  await panel
    .getByLabel('Why is this amendment being withdrawn?')
    .fill('Bob changed his mind and is staying.')
  await panel.getByRole('button', { name: 'Withdraw this amendment' }).click()
  await expect(page.getByText('Amendment withdrawn.')).toBeVisible()

  const change = await prisma.leasePartyChange.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { envelope: true },
  })
  expect(change.status).toBe('VOIDED')
  // The three CHECK constraints on this table each say that a status carries
  // exactly the timestamps it claims - a withdrawal with no reason on the row
  // would be refused by Postgres, not by the action.
  expect(change.voidedAt).not.toBeNull()
  expect(change.voidReason).toBe('Bob changed his mind and is staying.')
  expect(change.appliedAt).toBeNull()
  expect(change.envelope?.status).toBe('VOIDED')

  // Nobody moved. A withdrawn amendment is the record that somebody was
  // asked to sign themselves off the lease and then was not.
  expect(await prisma.leaseTenant.count({ where: { leaseId: lease.id } })).toBe(2)
  await expect(panel.getByText('Withdrawn — Bob changed his mind and is staying.')).toBeVisible()
})
