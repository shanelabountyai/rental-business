import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { Secret, TOTP } from 'otpauth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Screening accept/decline (LEASE-04, R-060) - the one surface everything
// else in this item feeds: criteria comparison and report ordering are
// proved directly against the database in lib/screening/screening.test.ts
// (see that file's own header for why recordScreeningDecision itself is
// excluded there and lives here instead - it is session-dependent via
// requirePermission/audit(), the same wall every other staff-actions.ts
// draws).

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const prospectIds: string[] = []

async function createStaff() {
  // MFA ENROLLED - `screening.decide` is a privileged permission (R-060
  // added it to PRIVILEGED_PERMISSIONS alongside fee.waive/workorder.approve),
  // and a fixture without MFA renders no decision control at all, the same
  // fact fee-waiver.spec.ts's own comment already establishes for its own
  // privileged permission.
  const unique = randomUUID().slice(0, 8)
  const email = `screen-${unique}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `Screening Manager ${unique}`,
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

/**
 * A household whose application has already completed and been screened -
 * ordering itself (order.ts, which also derives the report's own facts from
 * the simulated adapter) is proved directly against the database in
 * screening.test.ts; this seeds the COMPLETE report and SCREENED prospect
 * state by hand, the same call fee-waiver.spec.ts's own fixture makes for
 * the charge it waives, so this spec's DB writes stay resolvable without
 * reaching into apps/web/lib from outside Next's own module resolution.
 */
async function seedScreenedApplicant(
  monthlyIncomeCents: number,
  reportFacts: { evictionRecordFound: boolean; criminalRecordFound: boolean } = {
    evictionRecordFound: false,
    criminalRecordFound: false,
  },
  options: { withEmailAndAddress?: boolean } = {},
) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Screen LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Screen House-${unique}`,
      addressLine1: '12 Screening St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: property.id,
      listingId: listing.id,
      firstName: 'Casey',
      lastName: `Reed-${unique}`,
      email: `casey-${unique}@example.test`,
      source: 'direct',
      // SCREENED, not APPLIED - order.ts's own job (proved in
      // screening.test.ts) is exactly this transition; this fixture starts
      // past it so the spec can focus on the decision UI.
      status: 'SCREENED',
      preScreenRespondedAt: new Date(),
    },
  })
  prospectIds.push(prospect.id)
  const application = await prisma.application.create({
    data: { propertyId: property.id, listingId: listing.id, prospectId: prospect.id, completedAt: new Date() },
  })
  const applicant = await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      monthlyIncomeCents,
      formSubmittedAt: new Date(),
      completedAt: new Date(),
      ...(options.withEmailAndAddress
        ? {
            email: `applicant-${unique}@example.test`,
            currentAddressLine1: '45 Current St',
            currentCity: 'Houston',
            currentState: 'TX',
            currentPostalCode: '77003',
          }
        : {}),
    },
  })
  const criteria = await prisma.screeningCriteria.findFirstOrThrow({
    where: { effectiveTo: null },
    orderBy: { version: 'desc' },
  })
  await prisma.screeningReport.create({
    data: {
      applicantId: applicant.id,
      providerId: `scr_${randomUUID().slice(0, 24)}`,
      status: 'COMPLETE',
      creditScore: 720,
      evictionRecordFound: reportFacts.evictionRecordFound,
      criminalRecordFound: reportFacts.criminalRecordFound,
      // What SimulatedScreeningAdapter's own agency renders to (order.ts's
      // join) - hand-seeded here since this fixture bypasses
      // orderScreeningForApplicant, the same wall screening.test.ts's own
      // header names.
      agencyContact: 'Simulated Consumer Reporting Agency (not a real bureau)\n1 Simulated Bureau Way\nAustin, TX 78701\n(800) 555-0100',
      criteriaVersion: criteria.version,
      completedAt: new Date(),
    },
  })

  return { property, prospect, application, applicant }
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

// Login is rate-limited per IP (R-003) - the same distinct-address guard
// every sign-in-heavy spec carries.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // NoticeDelivery is append-only by trigger (CLAUDE.md's own rule), and
  // Notice.applicantId is RESTRICT - so a Notice with a delivery on it
  // (the auto-served adverse-action spec below) cannot be deleted, and
  // neither can the Applicant/Application/Prospect chain underneath it.
  // Retire, don't delete: only the tables that carry an `active` flag get
  // one here, the same choice every other spec in this suite already
  // makes for rows an append-only table references.
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('shows the report criteria and records an explicit approve decision', async ({ page }) => {
  const staff = await createStaff()
  // 4x the seeded 150,000c rent, comfortably over the 3x floor.
  const { prospect, property } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await expect(page.getByRole('heading', { name: 'Screening', exact: true })).toBeVisible()
  await expect(page.getByText(/Reported income requires/)).toBeVisible()

  const screeningSection = page.getByRole('region', { name: 'Screening', exact: true })
  await page.getByLabel('Decision').selectOption('APPROVED')
  await page.getByRole('button', { name: 'Record decision' }).click()

  await expect(screeningSection.getByText('Approved')).toBeVisible()

  await expect
    .poll(async () => {
      const row = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
      return row.status
    })
    .toBe('APPROVED')

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'screening.decided', propertyId: property.id },
  })
  expect(audited?.actorType).toBe('STAFF')
})

test('refuses a decline with no individualized-assessment note', async ({ page }) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('DECLINED')
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText(/individualized-assessment note is required/)).toBeVisible()

  const report = await prisma.screeningReport.findUniqueOrThrow({
    where: { applicantId: applicant.id },
  })
  expect(report.decision).toBeNull()

  // React resets an uncontrolled form after every action call, success or
  // failure - the decision select goes back to its placeholder along with
  // everything else, the same reason every OTHER form in this codebase that
  // can fail validation is a single round trip rather than a fix-one-field
  // retry. Re-selecting is what a real person does too: read the error, redo
  // the whole form.
  await page.getByLabel('Decision').selectOption('DECLINED')
  await page.getByLabel('Individualized-assessment notes').fill('Two evictions in the last year.')
  await page.getByRole('button', { name: 'Record decision' }).click()
  // One match only because the badge and the <option> differ by one letter:
  // the badge is "Declined" (`prospects/[id]/page.tsx`) and the select's
  // option is "Decline" (`screening-decision-form.tsx`), which does not
  // contain it. The form is still mounted after the action - see the comment
  // above - so relabelling that option "Declined" makes this a strict-mode
  // violation, and an <option> in a closed dropdown still counts (R-136).
  await expect(page.getByText('Declined')).toBeVisible()

  // No separate ProspectStatus for a decline - the pipeline stays at
  // SCREENED, right where the fixture started it.
  const updated = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
  expect(updated.status).toBe('SCREENED')
})

test('a decline generates and auto-serves an FCRA adverse-action notice by email', async ({
  page,
}) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(
    600_000,
    { evictionRecordFound: true, criminalRecordFound: false },
    { withEmailAndAddress: true },
  )

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('DECLINED')
  await page.getByLabel('Individualized-assessment notes').fill('Recent eviction on record.')
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Declined')).toBeVisible()

  const report = await prisma.screeningReport.findUniqueOrThrow({
    where: { applicantId: applicant.id },
    include: { adverseActionNotice: { include: { deliveries: true } } },
  })
  const notice = report.adverseActionNotice
  expect(notice).not.toBeNull()
  expect(notice?.type).toBe('ADVERSE_ACTION')
  expect(notice?.applicantId).toBe(applicant.id)
  expect(notice?.bodyText).toContain('Simulated Consumer Reporting Agency')
  expect(notice?.bodyText).toMatch(/free copy of your report/)
  expect(notice?.bodyText).toContain('A record was found')
  // Auto-served by EMAIL, the moment the decision was recorded - no separate
  // staff click.
  expect(notice?.servedAt).not.toBeNull()
  expect(notice?.serviceMethod).toBe('EMAIL')
  expect(notice?.deliveries).toHaveLength(1)
  expect(notice?.deliveries[0]?.method).toBe('EMAIL')

  const emailed = await prisma.notification.findFirst({
    where: { recipientType: 'APPLICANT', recipientId: applicant.id, templateKey: 'application.adverse_action' },
  })
  expect(emailed).not.toBeNull()

  // Visible on the Prospect page too.
  await expect(page.getByText(/Adverse-action notice:.*Sent/)).toBeVisible()
})

test('a conditional approval with no reachable adverse-action notice blocks closing until overridden', async ({
  page,
}) => {
  const staff = await createStaff()
  // No email/address on file, so the notice cannot auto-serve - the
  // realistic "we can't reach them" gap the block exists for.
  const { prospect, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('APPROVED_WITH_CONDITIONS')
  await page.getByLabel('Individualized-assessment notes').fill('Approved with a co-signer.')
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Approved with conditions')).toBeVisible()
  await expect(page.getByText(/Adverse-action notice:.*Not sent yet/)).toBeVisible()

  // NOT auto-advanced to APPROVED - the notice is unsent (staff-actions.ts's
  // own `noneOwed` guard).
  let current = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
  expect(current.status).toBe('SCREENED')

  // Trying to move the pipeline to Approved by hand is blocked too.
  await page.getByLabel('Move to stage').selectOption('APPROVED')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText(/No adverse-action notice sent/)).toBeVisible()

  current = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
  expect(current.status).toBe('SCREENED')

  // Override, with a reason - the escape hatch.
  await page.getByLabel('Move to stage').selectOption('APPROVED')
  await page.getByLabel('Why are you going ahead?').fill('Notice mailed by hand today; no email on file.')
  await page.getByRole('button', { name: 'Move ahead, with this reason' }).click()

  await expect
    .poll(async () => {
      const row = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
      return row.status
    })
    .toBe('APPROVED')

  const report = await prisma.screeningReport.findUniqueOrThrow({
    where: { applicantId: applicant.id },
  })
  expect(report.adverseActionOverriddenAt).not.toBeNull()
  expect(report.adverseActionOverrideReason).toMatch(/mailed by hand/)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'adverse_action.overridden', entityId: report.id },
  })
  expect(audited?.reason).toMatch(/mailed by hand/)
})
