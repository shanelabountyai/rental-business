import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone, uniqueClientHeaders, uniqueStateCode } from './fixtures.ts'

// R-003's login limiter is ten attempts per IP per five minutes, and local
// e2e traffic carries no x-forwarded-for - so without this every spec shares
// one bucket and the full sweep starts refusing sign-ins around test 200.
// See uniqueClientHeaders' own comment: the symptom looks nothing like the
// cause.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

// Notice to vacate + non-renewal (LEASE-11, RISK-06, R-066).
//
// Pure logic (the notice-period check, the non-renewal notice text) is
// proved in packages/core/leases/notice-to-vacate.test.ts, and the
// database half of the notice-period guard in
// apps/web/lib/leases/notice-period-check.test.ts. The retaliation
// interaction is covered by e2e/retaliation-guard.spec.ts, which this file
// deliberately does not repeat. What is left, and what only a browser
// proves: the just-cause requirement actually blocks a bare submission and
// the notice it serves carries the stated cause, and a tenant's own
// self-serve intake from the portal.

const PASSWORD = 'correct-horse-battery-staple'
// An isolated state code - a real JurisdictionRule row this spec controls
// fully, not the shared TX seed another spec could be reading concurrently.
// MINTED, not a constant: 'YY' was also written by
// `apps/web/lib/ledger/nsf-fees.test.ts` and asserted ABSENT by
// `apps/web/lib/jurisdiction/queries.test.ts`, and the
// @@unique([state, jurisdiction, version]) this comment used to lean on
// refuses nothing over a null jurisdiction (R-108).
const STATE = uniqueStateCode()

const staffIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ruleIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `vacate-${unique}@example.test`,
      name: `Vacate Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedJustCauseRule() {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: STATE,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      noticeToVacateDays: 30,
      justCauseRequired: true,
      paymentAllocationOrder: [],
    },
  })
  ruleIds.push(rule.id)
  return rule
}

async function seedLease(state: string) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Vacate LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Vacate House-${unique}`,
      addressLine1: '4 Departure Dr',
      city: 'Anytown',
      state,
      postalCode: '00000',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Morgan',
      lastName: `Vacate-${unique}`,
      email: `morgan-${unique}@example.test`,
      phone: uniquePhone(),
    },
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
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { property, unit, tenant, lease }
}

/// Mints a magic link the way the sign-in action would - the portal has no
/// password sign-in at all (e2e/notices.spec.ts's own identical helper).
async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

async function signInStaff(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  // NoticeDelivery is append-only and Notice.leaseId is RESTRICT - the
  // just-cause test below serves a real notice, so the lease chain beneath
  // it cannot be hard-deleted. Same shape retaliation-guard.spec.ts's own
  // afterAll now documents for the identical reason.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.jurisdictionRule.updateMany({
    where: { id: { in: ruleIds } },
    data: { effectiveTo: new Date('2020-01-02') },
  })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('an owner non-renewal in a just-cause jurisdiction requires a stated cause, and serves a real notice', async ({
  page,
}) => {
  await seedJustCauseRule()
  const { lease, tenant } = await seedLease(STATE)
  const staff = await createStaff()
  await signInStaff(page, staff.email)

  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Record notice to end the tenancy').click()
  await page.getByLabel('Who gave notice').selectOption('LANDLORD')
  await page.getByLabel('Date notice was given').fill('2026-08-01')
  // 45 days out - clear of the 30-day noticeToVacateDays, so only the
  // just-cause requirement is under test here.
  await page.getByLabel('Date the tenancy actually ends').fill('2026-09-15')
  await page.getByRole('button', { name: 'Record notice' }).click()

  // Matches twice - the FormAlerts banner and the field-level error below
  // the textarea, both carrying the identical message.
  await expect(
    page.getByText('This jurisdiction requires a stated cause for non-renewal.').first(),
  ).toBeVisible()
  await expect
    .poll(async () => (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt)
    .toBeNull()

  await page.getByLabel('Reason for non-renewal').fill('Owner is selling the property.')
  await page.getByRole('button', { name: 'Record notice' }).click()

  await expect(page.getByText(/still running until it ends/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'view non-renewal notice' })).toBeVisible()

  const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(after.noticeGivenAt).not.toBeNull()
  expect(after.noticeGivenBy).toBe('LANDLORD')
  expect(after.noticeEffectiveOn).not.toBeNull()
  // Never set for a landlord notice.
  expect(after.noticeForwardingAddress).toBeNull()

  const notice = await prisma.notice.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(notice.type).toBe('NON_RENEWAL')
  expect(notice.bodyText).toContain('Owner is selling the property.')

  const delivery = await prisma.noticeDelivery.findFirstOrThrow({ where: { noticeId: notice.id } })
  expect(delivery.method).toBe('PORTAL')

  await expect
    .poll(() =>
      prisma.notification.count({
        where: { recipientType: 'TENANT', recipientId: tenant.id, templateKey: 'lease.non_renewal' },
      }),
    )
    .toBeGreaterThan(0)
})

test("a tenant gives their own notice to vacate from the portal", async ({ page }) => {
  const { lease, tenant } = await seedLease('TX')

  await page.goto(await magicLinkFor(tenant.id))
  await page.goto('/portal/papers/notice')
  await expect(page.getByRole('heading', { name: 'Give notice to vacate' })).toBeVisible()

  // 40 days out - clear of TX's 30-day noticeToVacateDays.
  await page.getByLabel('When do you plan to move out?').fill('2026-09-25')
  await page.getByLabel('Forwarding address').fill('12 Next Place, Dallas, TX 75201')

  // R-112: the confirmation gate, BOTH LAYERS OF IT.
  //
  // The browser refuses first, on the checkbox's own `required`, so nothing
  // is submitted and nothing typed is lost. That matters more than it looks:
  // React resets an uncontrolled form's inputs on every action dispatch
  // (R-008), so a purely server-side refusal would empty the date and the
  // address a tenant had just filled in - the audit found that exact defect
  // on the vendor forms.
  await page.getByRole('button', { name: 'Give notice' }).click()
  await expect(page.getByRole('heading', { name: 'Give notice to vacate' })).toBeVisible()
  expect(
    (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt,
  ).toBeNull()

  // Strip the attribute and press again: the server is the gate that actually
  // holds, and a form posted without the box is what it has to refuse.
  await page.evaluate(() =>
    document.querySelector('#field-agree')?.removeAttribute('required'),
  )
  await page.getByRole('button', { name: 'Give notice' }).click()
  await expect(
    page.getByText('Tick the box to confirm you want to end your tenancy.'),
  ).toBeVisible()
  expect(
    (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt,
  ).toBeNull()

  // That dispatch emptied the two fields - see above. Refilling them here is
  // the behaviour being documented, not an incidental step.
  await page.getByLabel('When do you plan to move out?').fill('2026-09-25')
  await page.getByLabel('Forwarding address').fill('12 Next Place, Dallas, TX 75201')
  await page.getByLabel('I understand this ends my tenancy').check()
  await page.getByRole('button', { name: 'Give notice' }).click()

  // A server action always triggers a refresh of the page that called it -
  // the same trap /sign/[token] and /prescreen/[token] each document their
  // own fix for. The refreshed page here reads `noticeGivenAt` and swaps
  // straight to the "already on file" branch before the form's own
  // transient useActionState notice can ever paint, so THIS is the
  // confirmation a tenant who just submitted actually sees.
  await expect(page.getByRole('heading', { name: 'Notice already on file' })).toBeVisible()

  const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
  expect(after.noticeGivenAt).not.toBeNull()
  expect(after.noticeGivenBy).toBe('TENANT')
  expect(after.noticeEffectiveOn).not.toBeNull()
  expect(after.noticeForwardingAddress).toBe('12 Next Place, Dallas, TX 75201')
  // A tenant's own notice is an inbound fact, never a served Notice.
  expect(await prisma.notice.count({ where: { leaseId: lease.id } })).toBe(0)

  await page.goto('/portal/papers/notice')
  await expect(page.getByRole('heading', { name: 'Notice already on file' })).toBeVisible()
})
