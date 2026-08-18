import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// Lease generation + e-signature (LEASE-06, DOC-02, R-063).
//
// Pure logic (addenda selection, signer ordering, merge-field catalogue,
// document blocks) is proved directly in packages/core/leases/generation.test.ts.
// `generateAndSendLease`, `voidEnvelope` and `signLeaseDocument` are all
// session-dependent or public-token-authorized, the same wall every other
// staff-actions.ts/public-actions.ts pair in this repo draws - covered only
// here.
//
// THE SIGN LINK IS MINTED DIRECTLY, not read from a sent notification.
// `issueToken` (apps/web/lib/auth/store.ts) is `server-only` and cannot load
// into Playwright's plain-Node context - the same reason e2e/pay-link.spec.ts
// mints its own token rather than importing the app's helper. The shape is
// mirrored deliberately (mintToken + a matching AuthToken row), so a drift
// between this and the real minter shows up as a failing test here.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []
const templateIds: string[] = []

async function createStaff(mfa: boolean) {
  const unique = randomUUID().slice(0, 8)
  const email = `esign-${unique}@example.test`
  const enrolment = mfa ? createTotpEnrolment(email) : null
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `Esign Manager ${unique}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          ...(enrolment
            ? { mfaSecret: sealSecret(enrolment.secret), mfaEnrolledAt: new Date() }
            : {}),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, secret: enrolment?.secret }
}

async function seedDraftLease() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Esign LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Esign House-${unique}`,
      addressLine1: '21 Signature Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      // Built well after 1978 and with no other addenda triggers, so the
      // ONLY template this test needs is the base lease - LEAD_PAINT and
      // every other addendum stays un-triggered (packages/core/leases/addenda.ts's
      // own default: an unknown year built is treated as pre-1978).
      yearBuilt: 2015,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Jordan',
      lastName: `Esign-${unique}`,
      email: `jordan-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'DRAFT',
      startsOn: new Date('2026-09-01T00:00:00Z'),
      endsOn: new Date('2027-08-31T00:00:00Z'),
      rentCents: 160_000,
      depositCents: 160_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const guarantor = await prisma.guarantor.create({
    data: {
      leaseId: lease.id,
      firstName: 'Pat',
      lastName: `Guarantor-${unique}`,
      email: `pat-${unique}@example.test`,
    },
  })
  return { entity, property, unit, tenant, lease, guarantor }
}

/// Mirrors `issueToken('LEASE_SIGN', ...)`'s own write exactly - see this
/// file's own header for why it is minted directly rather than imported.
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
  staff: { email: string; secret?: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  if (staff.secret) {
    await page.waitForURL(/\/login\/mfa/)
    await page
      .getByLabel(/code/i)
      .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
    await page.getByRole('button', { name: 'Verify' }).click()
  }
  await page.waitForURL('**/dashboard')
}

test.beforeAll(async () => {
  // One base LEASE template, authored once and reused by every test in this
  // file - the same "no state, any state" default `findTemplate` falls back
  // to (DocumentTemplate.state's own comment).
  const author = await createStaff(false)
  const template = await prisma.documentTemplate.create({
    data: {
      name: `Esign lease template ${randomUUID().slice(0, 6)}`,
      documentType: 'LEASE',
      state: null,
      body: 'This lease is between {{entity.name}} and {{tenants.names}} for {{property.address}}, {{unit.name}}. Rent {{rent.amount}} due day {{rent.due_day}}. Deposit {{deposit.amount}}. Term {{term.starts_on}} to {{term.ends_on}}. Guarantors: {{guarantors.names}}. Pets: {{pet.terms}}. Prepared by {{staff.name}} on {{today}}.',
      createdByStaffId: author.id,
    },
  })
  templateIds.push(template.id)
})

// Login is rate-limited per IP (R-003) - the same distinct-address guard
// every sign-in-heavy spec carries.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Retire, don't delete - LeaseEnvelope/Document now RESTRICT-reference
  // this chain (LeaseEnvelope.leaseId, LeaseSigner.tenantId/guarantorId),
  // the same "evidence stays" posture screening.spec.ts's own cleanup
  // already documents for a chain a NoticeDelivery pins.
  await prisma.documentTemplate.updateMany({
    where: { id: { in: templateIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('generates a lease, sends it for signature, and activates the tenancy once every signer signs', async ({
  page,
  context,
}) => {
  const staff = await createStaff(true)
  const { property, lease, tenant, guarantor } = await seedDraftLease()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)
  await page.getByRole('button', { name: 'Generate & send for e-signature' }).click()

  await expect(page.getByText('Sent for signature')).toBeVisible()

  const envelope = await prisma.leaseEnvelope.findFirstOrThrow({
    where: { leaseId: lease.id },
    include: { signers: { orderBy: { order: 'asc' } } },
  })
  expect(envelope.status).toBe('SENT')
  // NOT asserted against `templateIds` - another worker running this same
  // spec concurrently may have its own equally-valid default (documentType
  // LEASE, state null) template active at the same moment, and
  // `findTemplate`'s own tie-break (newest wins) makes which one is
  // genuinely ambiguous under real parallel load. What matters is that a
  // real LEASE template was used, not whose fixture it was.
  const usedTemplate = await prisma.documentTemplate.findUniqueOrThrow({
    where: { id: envelope.templateId },
  })
  expect(usedTemplate.documentType).toBe('LEASE')
  expect(envelope.signers).toHaveLength(2)
  expect(envelope.signers[0]!.role).toBe('TENANT')
  expect(envelope.signers[0]!.tenantId).toBe(tenant.id)
  expect(envelope.signers[1]!.role).toBe('GUARANTOR')
  expect(envelope.signers[1]!.guarantorId).toBe(guarantor.id)

  const leaseAfterSend = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(leaseAfterSend.status).toBe('PENDING_SIGNATURE')

  // First signer (the tenant) signs, in a separate browser context - a real
  // signer holds no staff session at all.
  const tenantToken = await mintSignLink(envelope.signers[0]!.id)
  const tenantPage = await context.newPage()
  await tenantPage.goto(`/sign/${tenantToken}`)
  await expect(tenantPage.getByText(property.name)).toBeVisible()
  await tenantPage.getByLabel('Type your full legal name').fill('Jordan Esign')
  await tenantPage
    .getByLabel('I agree that typing my name above and submitting this form is my electronic signature on this lease.')
    .check()
  await tenantPage.getByRole('button', { name: 'Sign this lease' }).click()
  // NOT the action's own transient "Signed. Thank you." notice - a form
  // action always triggers a Server Component refresh once it completes,
  // which re-evaluates the page's own already-signed branch and unmounts
  // the form (and the notice living in its local state) before either can
  // paint. See sign/[token]/page.tsx's own comment on the same fact.
  await expect(
    tenantPage.getByText('Still waiting on the remaining signer(s)'),
  ).toBeVisible()

  // Still only partially signed - the lease has not activated yet.
  const midway = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(midway.status).toBe('PENDING_SIGNATURE')

  // Second signer (the guarantor) signs - the last one, so this completes
  // the envelope.
  const guarantorToken = await mintSignLink(envelope.signers[1]!.id)
  const guarantorPage = await context.newPage()
  await guarantorPage.goto(`/sign/${guarantorToken}`)
  await guarantorPage.getByLabel('Type your full legal name').fill('Patricia Guarantor')
  await guarantorPage
    .getByLabel('I agree that typing my name above and submitting this form is my electronic signature on this lease.')
    .check()
  await guarantorPage.getByRole('button', { name: 'Sign this lease' }).click()
  await expect(
    guarantorPage.getByText('Every signer has now completed, and the lease is active.'),
  ).toBeVisible()

  // The lease is live, billing followed the tenancy, and the deposit charge
  // created itself (this item's own words in the backlog).
  await expect
    .poll(async () => {
      const row = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
      return row.status
    })
    .toBe('ACTIVE')

  const completedEnvelope = await prisma.leaseEnvelope.findUniqueOrThrow({
    where: { id: envelope.id },
  })
  expect(completedEnvelope.status).toBe('COMPLETED')
  expect(completedEnvelope.executedDocumentId).not.toBeNull()

  const executedDocument = await prisma.document.findUniqueOrThrow({
    where: { id: completedEnvelope.executedDocumentId! },
  })
  expect(executedDocument.contentType).toBe('application/pdf')
  expect(executedDocument.sizeBytes).toBeGreaterThan(0)

  const depositCharge = await prisma.charge.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'DEPOSIT' },
  })
  expect(depositCharge.amountCents).toBe(160_000)

  const unitAfter = await prisma.unit.findUniqueOrThrow({ where: { id: lease.unitId } })
  expect(unitAfter.status).toBe('OCCUPIED')

  const completedAudit = await prisma.auditLog.findFirst({
    where: { action: 'envelope.completed', entityId: envelope.id },
  })
  expect(completedAudit).toBeTruthy()
})

test('refuses to send a lease for signature without two-factor verification', async ({ page }) => {
  const staff = await createStaff(false)
  const { lease } = await seedDraftLease()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await expect(page.getByText(/needs two-factor verification/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Generate & send for e-signature' })).toHaveCount(0)

  const envelopeCount = await prisma.leaseEnvelope.count({ where: { leaseId: lease.id } })
  expect(envelopeCount).toBe(0)
})
