import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The jurisdiction-rules engine (R-010, D-4). Portfolio-wide, unlike every
// other admin section built so far - a JurisdictionRule applies by state,
// not by property or entity, so there is no property/entity scoping to test
// here. What matters instead:
//
//   requirePermission('jurisdiction.read'/'jurisdiction.write') with no
//   resource only ever clears for a portfolio-wide grant (R-004's can()) -
//   correct here, so a property- or entity-scoped manager must be refused
//   even though their role carries the permission key.
//
// Every row this file creates uses state "WY" and a randomised jurisdiction
// string, never null/statewide - the real seeded TX statewide rule (and any
// statewide WY row another parallel test might create) must never collide
// with what this file writes and cleans up.

const PASSWORD = 'correct-horse-battery-staple'
const STATE = 'WY'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const ruleIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `jurisdiction-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Jurisdiction Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      propertyId: scope?.propertyId,
      legalEntityId: scope?.legalEntityId,
    },
  })
  return { ...staff, password: PASSWORD }
}

async function seedProperty() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Seed LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Seed House-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

async function seedRule(jurisdiction: string, overrides: { reviewedBy?: string } = {}) {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: STATE,
      jurisdiction,
      version: 1,
      effectiveFrom: new Date('2026-01-01'),
      graceDays: 2,
      lateFeeType: 'FLAT',
      lateFeeFlatCents: 5000,
      depositEscrowRequired: false,
      depositInterestRequired: false,
      justCauseRequired: false,
      paymentAllocationOrder: ['RENT'],
      rubsPermitted: true,
      reviewedBy: overrides.reviewedBy ?? null,
    },
  })
  ruleIds.push(rule.id)
  return rule
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  const auditedRules = new Set(
    (
      await prisma.auditLog.findMany({
        where: { entityType: 'JurisdictionRule', entityId: { in: ruleIds } },
        select: { entityId: true },
      })
    ).map((row) => row.entityId),
  )
  await prisma.jurisdictionRule.deleteMany({
    where: { id: { in: ruleIds.filter((id) => !auditedRules.has(id)) } },
  })
  // JurisdictionRule has no `active`/soft-delete column (unlike Property) - a
  // version created through the real action and therefore audited is simply
  // left in place. It is real data (a genuine, if throwaway, config version),
  // not PII, and the same "leave what the trigger makes undeletable" rule
  // R-009 and R-008 both hit applies here with no cleanup step available.

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...auditedStaff] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('viewing and creating jurisdiction rules', () => {
  test('an owner sees the seeded Texas rule and an unreviewed badge', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction')
    await expect(page.getByText('TX — Statewide')).toBeVisible()
    await expect(page.getByRole('link', { name: 'New configuration' })).toBeVisible()
  })

  test('creates a new jurisdiction configuration end to end', async ({ page }) => {
    const jurisdiction = `Test County ${randomUUID().slice(0, 8)}`
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction/new')
    await page.getByLabel('State').selectOption(STATE)
    await page.getByLabel('City or county (optional)').fill(jurisdiction)
    await page.getByLabel('Effective from').fill('2026-01-01')
    await page.getByLabel('Grace days').fill('3')
    await page.getByLabel('Late-fee type').selectOption('PERCENT_OF_RENT')
    await page.getByLabel('Percent of rent (%)').fill('10')
    await page.getByRole('button', { name: 'Create configuration' }).click()

    await page.waitForURL(/\/jurisdiction\?versioned=/)
    await expect(page.getByText(`${STATE} — ${jurisdiction}`)).toBeVisible()

    const created = await prisma.jurisdictionRule.findFirst({
      where: { state: STATE, jurisdiction },
    })
    ruleIds.push(created!.id)
    expect(created?.version).toBe(1)
    expect(created?.lateFeePercentBps).toBe(1000)

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'JurisdictionRule', entityId: created!.id },
    })
    expect(entry?.action).toBe('jurisdiction_rule.versioned')
  })

  test('adding a version closes out the one it replaces', async ({ page }) => {
    const jurisdiction = `Test County ${randomUUID().slice(0, 8)}`
    const previous = await seedRule(jurisdiction)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(
      `/jurisdiction/new?state=${STATE}&jurisdiction=${encodeURIComponent(jurisdiction)}`,
    )
    // Prefilled from the version it supersedes.
    await expect(page.getByLabel('Grace days')).toHaveValue('2')

    await page.getByLabel('Effective from').fill('2027-01-01')
    await page.getByRole('button', { name: 'Add version' }).click()
    await page.waitForURL(/\/jurisdiction\?versioned=/)

    const rows = await prisma.jurisdictionRule.findMany({
      where: { state: STATE, jurisdiction },
      orderBy: { version: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]!.id).toBe(previous.id)
    expect(rows[0]!.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-12-31')
    expect(rows[1]!.version).toBe(2)
    rows.forEach((r) => ruleIds.push(r.id))
  })

  // R-153. createRuleVersion used to write only the fields the form
  // rendered, so nine statutory columns fell to schema defaults on every new
  // version - an uncapped NSF fee, a dead disposal workflow, a wiped
  // service-method map. Fully populate v1, change exactly one field through
  // the real form, and assert EVERY column of v2 is equal or deliberately
  // changed - so a schema column the form has not learned to render yet
  // fails this test the moment a version drops it.
  test('a new version carries every statutory column forward', async ({ page }) => {
    const jurisdiction = `Test County ${randomUUID().slice(0, 8)}`
    const v1 = await prisma.jurisdictionRule.create({
      data: {
        state: STATE,
        jurisdiction,
        version: 1,
        effectiveFrom: new Date('2026-01-01'),
        graceDays: 2,
        lateFeeType: 'FLAT_PLUS_DAILY',
        lateFeeFlatCents: 5000,
        lateFeeDailyCents: 500,
        lateFeeMaxCents: 10000,
        lateFeeMaxPercentBps: 1200,
        depositMaxBps: 20000,
        depositDispositionDays: 30,
        depositEscrowRequired: true,
        depositInterestRequired: true,
        preMoveOutWalkthroughRequired: true,
        preMoveOutWalkthroughDaysBefore: 14,
        entryNoticeHours: 24,
        payOrQuitDays: 3,
        noticeToVacateDays: 30,
        rentIncreaseNoticeDays: 60,
        rentIncreaseCapPercentBps: 500,
        retaliationWindowDays: 180,
        justCauseRequired: true,
        abandonmentPresumedAfterDays: 15,
        belongingsStorageDays: 30,
        // 0 on purpose: "expressly none needed" must survive the round trip
        // as 0, not collapse to null.
        belongingsNoticeDays: 0,
        leaseViolationCureDays: 14,
        // Methods in NOTICE_SERVICE_METHODS render order, because the form
        // submits checkboxes in DOM order - a semantically-equal but
        // reordered list would fail the toEqual below for the wrong reason.
        noticeServiceMethods: {
          ENTRY_NOTICE: ['EMAIL'],
          NOTICE_TO_VACATE: ['PERSONAL', 'CERTIFIED_MAIL'],
        },
        paymentAllocationOrder: ['RENT', 'LATE_FEE'],
        nsfFeePermitted: true,
        nsfFeeMaxCents: 3000,
        cardSurchargePolicy: 'CREDIT_ONLY',
        cardSurchargeMaxBps: 300,
        applicationFeeCapCents: 7500,
        rubsPermitted: false,
        sourceOfIncomeProtected: true,
        earlyTerminationRightExists: true,
        earlyTerminationNoticeDays: 30,
        earlyTerminationDocumentationTypes: ['PROTECTIVE_ORDER'],
        citation: 'Test Stat. §1',
        reviewedBy: 'Counsel Q. Test',
        notes: 'fully populated for the carry-forward test',
      },
    })
    ruleIds.push(v1.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(
      `/jurisdiction/new?state=${STATE}&jurisdiction=${encodeURIComponent(jurisdiction)}`,
    )
    await expect(page.getByLabel('Grace days')).toHaveValue('2')
    await page.getByLabel('Effective from').fill('2027-01-01')
    await page.getByLabel('Grace days').fill('9')
    await page.getByRole('button', { name: 'Add version' }).click()
    await page.waitForURL(/\/jurisdiction\?versioned=/)

    const v2 = await prisma.jurisdictionRule.findFirstOrThrow({
      where: { state: STATE, jurisdiction, version: 2 },
    })
    ruleIds.push(v2.id)

    const deliberatelyChanged = new Set([
      'id',
      'version',
      'effectiveFrom',
      'effectiveTo',
      'createdAt',
      'updatedAt',
      'graceDays',
      // Not carried forward on purpose: a new version is a new legal
      // question - see the prefill's own comment in new/page.tsx.
      'reviewedBy',
    ])
    for (const [column, was] of Object.entries(v1)) {
      if (deliberatelyChanged.has(column)) continue
      expect(v2[column as keyof typeof v2], column).toEqual(was)
    }
    expect(v2.graceDays).toBe(9)
    expect(v2.reviewedBy).toBeNull()
  })

  test('rejects a late fee type with no matching amount', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction/new')
    await page.getByLabel('State').selectOption(STATE)
    await page.getByLabel('Effective from').fill('2026-01-01')
    await page.getByLabel('Grace days').fill('3')
    await page.getByLabel('Late-fee type').selectOption('FLAT')
    await page.getByRole('button', { name: 'Create configuration' }).click()

    await expect(page.getByText('Enter the flat late fee in cents.')).toBeVisible()
    await expect(page).toHaveURL('/jurisdiction/new')
  })
})

test.describe('portfolio-wide only', () => {
  test('a portfolio-wide manager can read but not write', async ({ page }) => {
    const staff = await createStaff('manager')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction')
    await expect(page).not.toHaveURL(/\/no-access/)
    await expect(page.getByRole('link', { name: 'New configuration' })).toHaveCount(0)

    await page.goto('/jurisdiction/new')
    await expect(page).toHaveURL(/\/no-access/)
  })

  test('a property-scoped manager is refused entirely, despite holding jurisdiction.read', async ({
    page,
  }) => {
    // R-004's can(): a resource-less permission check only ever clears for a
    // portfolio-wide grant. jurisdiction.read/write are exactly that kind of
    // check (see permissions.ts), so a scoped manager - who genuinely carries
    // the permission key on their role - is still refused. Deliberate, not a
    // bug: see this file's own top-of-file comment.
    const property = await seedProperty()
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)

    await page.goto('/jurisdiction')
    await expect(page).toHaveURL(/\/no-access/)
  })

  test('a maintenance tech has no access at all', async ({ page }) => {
    const staff = await createStaff('maintenance_tech')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction')
    await expect(page).toHaveURL(/\/no-access/)
  })
})

test.describe('accessibility', () => {
  test('the list and new-configuration pages have no detectable violations', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/jurisdiction')
    let results = await axeScan(page)
    expect(results.violations).toEqual([])

    await page.goto('/jurisdiction/new')
    results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
