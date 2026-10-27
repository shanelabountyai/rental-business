import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { Secret, TOTP } from 'otpauth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { localInputValue, safeTimeZone } from './fixtures.ts'

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
    data: { orgMemberships: { create: { orgId: 'org_0' } },
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
  reportFacts: { evictionRecordFound: boolean; criminalRecordFound: boolean; evictionRecordOn?: Date } = {
    evictionRecordFound: false,
    criminalRecordFound: false,
  },
  options: { withEmailAndAddress?: boolean } = {},
) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { orgId: 'org_0', name: `Screen LLC-${unique}`, type: 'LLC' },
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
      // R-237: safe from quiet hours right now, so the auto-served
      // adverse-action notice below is not gambling on the wall clock.
      timezone: safeTimeZone(),
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
      evictionRecordOn: reportFacts.evictionRecordOn ?? null,
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
  // 4x the seeded 150,000c rent, comfortably over the 3x floor. An email on
  // file so the approval (R-270) has a channel that can reach them.
  const { prospect, property, application, applicant } = await seedScreenedApplicant(
    600_000,
    undefined,
    { withEmailAndAddress: true },
  )
  // The review Task a real completion opens (R-269, fee-webhook.ts) - the
  // fixture skips completion, so it is seeded here to prove the decision
  // closes it.
  const review = await prisma.task.create({
    data: {
      propertyId: property.id,
      type: 'application.review',
      subjectType: 'Application',
      subjectId: application.id,
      businessDate: new Date(),
      priority: 'ROUTINE',
      title: 'Review the application',
    },
  })

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
  const closed = await prisma.task.findUniqueOrThrow({ where: { id: review.id } })
  expect(closed.status).toBe('DONE')

  // R-270 (PRD 08 C5): the approved household becomes a lease draft in the
  // ordinary lease flow, with the applicant on it as the primary tenant.
  const draft = await prisma.lease.findUniqueOrThrow({
    where: { applicationId: application.id },
    include: { leaseTenants: { include: { tenant: true } } },
  })
  expect(draft.status).toBe('DRAFT')
  expect(draft.origin).toBe('APPLICATION')
  expect(draft.rentCents).toBe(150_000)
  expect(draft.leaseTenants).toHaveLength(1)
  expect(draft.leaseTenants[0]?.isPrimary).toBe(true)
  expect(draft.leaseTenants[0]?.tenant.lastName).toBe(prospect.lastName)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Open the lease draft' })).toHaveAttribute(
    'href',
    `/leases/${draft.id}`,
  )

  // R-270 (PRD 08 C4): and the approval goes to the applicant.
  const approval = await prisma.notification.findFirst({
    where: { recipientType: 'APPLICANT', recipientId: applicant.id, templateKey: 'application.approved', channel: 'EMAIL' },
  })
  expect(approval?.body).toContain('is approved')
  await expect(screeningSection.getByText('Approval (email):')).toBeVisible()

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'screening.decided', propertyId: property.id },
  })
  expect(audited?.actorType).toBe('STAFF')
})

test('an approval that cannot open a draft raises a Task and warns on the page (D-336)', async ({ page }) => {
  const staff = await createStaff()
  const { prospect, property, application } = await seedScreenedApplicant(600_000)
  // Somebody already lives in the unit, so openLeaseDraft refuses.
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: application.listingId } })
  await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: listing.unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)
  await page.getByLabel('Decision').selectOption('APPROVED')
  await page.getByRole('button', { name: 'Record decision' }).click()

  await expect(page.getByText(/no lease draft is\s+open/)).toBeVisible()
  expect(await prisma.lease.findUnique({ where: { applicationId: application.id } })).toBeNull()
  const task = await prisma.task.findFirst({
    where: { type: 'application.lease_draft', subjectId: application.id },
  })
  expect(task?.title).toMatch(/the unit already has a live tenancy/)
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
  await page.getByLabel('Reason from the list').selectOption('RENTAL_HISTORY')
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

test('refuses a decline with no reason from the list (R-269)', async ({ page }) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('DECLINED')
  await page.getByLabel('Individualized-assessment notes').fill('Two evictions in the last year.')
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText('Choose the reason for this decision from the list.')).toBeVisible()

  const report = await prisma.screeningReport.findUniqueOrThrow({
    where: { applicantId: applicant.id },
  })
  expect(report.decision).toBeNull()
})

test('records a request for more info without deciding (R-269)', async ({ page }) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('What you need from them').fill('Two recent pay stubs.')
  await page.getByRole('button', { name: 'Request more info' }).click()
  await expect(page.getByText(/More info requested .*:/)).toBeVisible()
  // R-270: this fixture's applicant has no email and no phone, so nothing
  // can reach them - and the form says so rather than claiming a send.
  await expect(page.getByText(/Recorded, but NOT SENT/)).toBeVisible()
  await expect(page.getByText('More-info request (email):')).toBeVisible()

  const requests = await prisma.applicantInfoRequest.findMany({ where: { applicantId: applicant.id } })
  expect(requests.map((r) => r.request)).toEqual(['Two recent pay stubs.'])
  const report = await prisma.screeningReport.findUniqueOrThrow({
    where: { applicantId: applicant.id },
  })
  expect(report.decision).toBeNull()
  // Still undecided, so the decision form is still there.
  await expect(page.getByRole('button', { name: 'Record decision' })).toBeVisible()
})

test('shows income to rent and saves an internal note the applicant never sees (R-271)', async ({
  page,
}) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await expect(page.getByText('Income to rent')).toBeVisible()
  await expect(page.getByText(/× the asking rent/)).toBeVisible()

  await page.getByLabel('Internal note').fill('Pay stubs match the stated employer.')
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('Note saved. It is internal and never sent to the applicant.')).toBeVisible()
  await expect(page.getByText('Pay stubs match the stated employer.')).toBeVisible()

  const notes = await prisma.applicantNote.findMany({ where: { applicantId: applicant.id } })
  expect(notes.map((n) => n.body)).toEqual(['Pay stubs match the stated employer.'])
  // Staff-only: no notification was written for it.
  expect(await prisma.notification.count({ where: { recipientId: applicant.id } })).toBe(0)
})

test('a decline generates and auto-serves an FCRA adverse-action notice by email', async ({
  page,
}) => {
  const staff = await createStaff()
  const { prospect, applicant } = await seedScreenedApplicant(
    600_000,
    // Dated inside the lookback: an undated record is never cited (LEGAL-01).
    { evictionRecordFound: true, criminalRecordFound: false, evictionRecordOn: new Date(Date.now() - 365 * 86_400_000) },
    { withEmailAndAddress: true },
  )

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('DECLINED')
  await page.getByLabel('Reason from the list').selectOption('RENTAL_HISTORY')
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
  // R-269: the reason is recorded, and kept OUT of the notice while the list
  // is unreviewed placeholder wording (OQ-16, D-333). The decision records
  // which wording of the notice it sent.
  expect(notice?.bodyText).not.toContain('after individualized assessment')
  expect(report.decisionReasonCode).toBe('RENTAL_HISTORY')
  expect(report.decisionTemplateVersion).toMatch(/^adverse-action\//)
  // LEGAL-02: the score is disclosed. This fixture's report carries no
  // disclosure facts (a pre-LEGAL-02 row), so the notice says so.
  expect(notice?.bodyText).toContain('Your credit score: 720')
  expect(notice?.bodyText).toMatch(/Range of possible scores: not reported by the agency/)
  expect(notice?.bodyText).toMatch(/A record dated .* was found within the \d+-month lookback/)
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
  // R-270: the decline text is SMS only (the email is the notice), and this
  // applicant has no phone, so it is recorded as not sent.
  const texted = await prisma.notification.findFirst({
    where: { recipientType: 'APPLICANT', recipientId: applicant.id, templateKey: 'application.declined' },
    include: { delivery: true },
  })
  expect(texted?.channel).toBe('SMS')
  expect(texted?.delivery?.status).toBe('SUPPRESSED')

  // Visible on the Prospect page too.
  await expect(page.getByText(/Adverse-action notice:.*Sent/)).toBeVisible()
})

test('a conditional approval with no reachable adverse-action notice blocks closing until overridden', async ({
  page,
}) => {
  const staff = await createStaff()
  // No email/address on file, so the notice cannot auto-serve - the
  // realistic "we can't reach them" gap the block exists for.
  const { prospect, application, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)

  await page.getByLabel('Decision').selectOption('APPROVED_WITH_CONDITIONS')
  await page.getByLabel('Reason from the list').selectOption('INCOME_BELOW_CRITERIA')
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

  // D-335: the override cleared the household's last blocker, so it gets
  // what the automatic advance would have given it.
  await expect
    .poll(async () => (await prisma.lease.findUnique({ where: { applicationId: application.id } }))?.status)
    .toBe('DRAFT')
  const approval = await prisma.notification.findFirst({
    where: { recipientType: 'APPLICANT', recipientId: applicant.id, templateKey: 'application.approved' },
  })
  expect(approval).not.toBeNull()
})

test('serving an owed adverse-action notice by post approves the household and opens its draft (D-335)', async ({
  page,
}) => {
  const staff = await createStaff()
  const { prospect, property, application, applicant } = await seedScreenedApplicant(600_000)

  await signIn(page, staff)
  await page.goto(`/prospects/${prospect.id}`)
  await page.getByLabel('Decision').selectOption('APPROVED_WITH_CONDITIONS')
  await page.getByLabel('Reason from the list').selectOption('INCOME_BELOW_CRITERIA')
  await page.getByLabel('Individualized-assessment notes').fill('Approved with a co-signer.')
  await page.getByRole('button', { name: 'Record decision' }).click()
  await expect(page.getByText(/Adverse-action notice:.*Not sent yet/)).toBeVisible()

  const report = await prisma.screeningReport.findUniqueOrThrow({ where: { applicantId: applicant.id } })
  expect(await prisma.lease.findUnique({ where: { applicationId: application.id } })).toBeNull()

  await page.goto(`/notices/${report.adverseActionNoticeId}`)
  await page.getByLabel('How was it served?').selectOption('CERTIFIED_MAIL')
  await page.getByLabel('When was it served?').fill(localInputValue(1, property.timezone))
  await page.getByLabel('Certified-mail article number').fill('9407 1000 0000 0000 0000 35')
  await page.getByRole('button', { name: 'Record service' }).click()
  await expect(page.getByText(/9407 1000/)).toBeVisible()

  await expect
    .poll(async () => (await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).status)
    .toBe('APPROVED')
  await expect
    .poll(async () => (await prisma.lease.findUnique({ where: { applicationId: application.id } }))?.status)
    .toBe('DRAFT')
})
