import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The Monday-morning report, and the one press that chases everybody on it
// (PAY-06, RPT-02, R-044).
//
// ==========================================================================
// THE ONE THING THIS FILE EXISTS TO PROVE: BEING LATE AND BEING CHASEABLE ARE
// DIFFERENT.
//
// Texas's seeded rule grants ONE day of grace. A tenant one day past due is
// visibly delinquent on this screen AND must not be selectable for a chase.
// (The number is read from the seed rather than assumed — the first draft of
// this file guessed five days and every assertion inverted.) If the
// two were ever wired to the same boolean nothing else in the product would
// notice — the screen would look completely correct — and the first sign
// would be a fair-housing complaint about chasing tenants who were not yet
// late by the only definition that matters.
//
// So: one tenancy inside grace, one past it, and assertions on both.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const staffIds: string[] = []
const templateIds: string[] = []

/// `YYYY-MM-DD`, N days before today IN THE PROPERTY'S OWN TIMEZONE.
///
/// The comment here used to say "property-local by construction" and it was
/// not true: `new Date()` read through UTC getters is the SERVER's calendar
/// day. For the several hours each evening when UTC has rolled over and
/// Chicago has not, every fixture below was silently a day younger than
/// intended - the "one day late" tenancy landed on today's date, aged as
/// `current`, and failed the grace assertions. Three consecutive sweeps
/// wrote it off as flakiness before the claim in this comment was checked.
///
/// The seeded property is America/Chicago, and `delinquencyFor` ages against
/// the PROPERTY's today (D-3), so the fixture has to be built from the same
/// clock the assertion is judged by.
function daysAgo(n: number): Date {
  const d = businessDateToUtc(businessDate(new Date(), 'America/Chicago'))
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

async function seedPropertyWithTenancies(
  options: { includeUnlinkedRent?: boolean } = {},
) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Roll LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Roll House-${stamp}`,
      addressLine1: '9 Rent Roll Road',
      city: 'Houston',
      // TEXAS, because R-010 seeds its rule with a real grace period. A state
      // with no rule would make every tenancy "grace unknown" and the whole
      // distinction under test would collapse.
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  /// One tenancy owing rent, due `dueDaysAgo` days ago.
  async function tenancy(label: string, dueDaysAgo: number) {
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: `${label}-${stamp}`, status: 'OCCUPIED' },
    })
    unitIds.push(unit.id)
    const tenant = await prisma.tenant.create({
      data: {
        // STAMPED, so the name cannot collide with the screen's own words.
        // Naming them "Within" and "Past" made `getByRole('row', {name})`
        // match every row on the page, because each one renders "still within
        // grace" or "past grace" into its accessible name.
        firstName: `${label}${stamp}`,
        lastName: `Roll-${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@example.test`,
        phone: uniquePhone(),
      },
    })
    tenantIds.push(tenant.id)
    const dueDate = daysAgo(dueDaysAgo)
    // MATCHES THE FABRICATED CHARGE BELOW, deliberately. Production never
    // creates both a dated 'RENT' Charge AND an independent rentDueDay for
    // the SAME debt - only the exceptions (a late fee, a proration) get a
    // Charge row, and this test fabricates one to stand in for them. Leaving
    // rentDueDay at its unrelated schema default let `nearestRentDueOn`
    // disagree with the fabricated Charge's own due date once R-045 started
    // computing it, aging this fixture from a date nothing else in the test
    // referred to.
    const lease = await prisma.lease.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
        rentDueDay: dueDate.getUTCDate(),
      },
    })
    leaseIds.push(lease.id)
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: property.id,
        payerType: 'TENANT',
        tenantId: tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })

    // A DATED CHARGE, like a late fee or a proration carries. Realistic for
    // those, NOT for ordinary rent — see `unlinkedRentTenancy` below for the
    // shape production rent actually takes.
    const charge = await prisma.charge.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'RENT',
        amountCents: 150_000,
        description: 'Rent',
        dueOn: dueDate,
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        chargeId: charge.id,
        type: 'CHARGE',
        amountCents: 150_000,
        occurredAt: dueDate,
        description: 'Rent',
      },
    })
    return { tenant, lease, unit }
  }

  /**
   * ORDINARY RENT, THE WAY PRODUCTION ACTUALLY WRITES IT.
   *
   * D-11/D-40 mint no `Charge` row for the subscription's own rent line -
   * only the exceptions (a late fee, a proration, a chargeback) get one. So
   * the webhook posts an UNLINKED ledger entry, and the only record of when
   * that rent was due at all is `Lease.rentDueDay` - nothing dated on the
   * entry itself. This is the case R-045 found `delinquencyFor` silently
   * mis-reporting as `current`, and it is the one every OTHER tenancy in
   * this file, seeded with a Charge row above, does not exercise.
   */
  async function unlinkedRentTenancy(label: string, dueDaysAgo: number) {
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: `${label}-${stamp}`, status: 'OCCUPIED' },
    })
    unitIds.push(unit.id)
    const tenant = await prisma.tenant.create({
      data: { firstName: `${label}${stamp}`, lastName: `Roll-${stamp}`, phone: uniquePhone() },
    })
    tenantIds.push(tenant.id)
    const dueDate = daysAgo(dueDaysAgo)
    const lease = await prisma.lease.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
        // `dueDaysAgo`'s day-of-month, so `dueDateOnOrBefore` reproduces this
        // exact date - the same fixture-consistency fix `tenancy()` needed
        // above. KEEP `dueDaysAgo` UNDER ~28: `dueDateOnOrBefore` can only
        // anchor to the MOST RECENT occurrence of a day-of-month, so it is
        // never more than about a month in the past by construction. That
        // is the documented limitation on `nearestRentDueOn` itself
        // (understating a tenancy owing more than one month) - it is not
        // something this fixture can exceed to prove a "30+" bucket, and
        // asserting one here would be asserting a day-of-month coincidence
        // rather than the fix.
        rentDueDay: dueDate.getUTCDate(),
      },
    })
    leaseIds.push(lease.id)
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: property.id,
        payerType: 'TENANT',
        tenantId: tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    // NO CHARGE ROW. The projection's own remainder shape (webhook.ts's
    // "rent from the subscription itself has no Charge row" comment) -
    // `chargeId: null`. `occurredAt` only feeds the LEDGER balance here; the
    // AGING comes entirely from `rentDueDay` above, which is the point of
    // the test - `delinquencyFor` never reads a LedgerEntry's own timestamp.
    await prisma.ledgerEntry.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        chargeId: null,
        type: 'CHARGE',
        amountCents: 150_000,
        occurredAt: dueDate,
        description: 'Rent',
      },
    })
    return { tenant, lease, unit }
  }

  // ONE day late. Texas's seeded rule grants exactly one day of grace
  // (Property Code §92.019 requires rent be a full day late before a fee), so
  // this tenancy is in the 0–5 bucket AND still within grace — which is the
  // whole distinction under test. Written from the seeded value rather than
  // assumed: the first draft of this file guessed five days and failed.
  const within = await tenancy('Within', 1)
  // Twenty days late: past grace by any reading.
  const past = await tenancy('Past', 20)
  // OPT-IN. Also past grace, so a test that does not ask for it and does
  // not destructure it would otherwise gain a SECOND chaseable tenancy it
  // never intended - exactly what happened to the send-related tests the
  // first time this was unconditional.
  const unlinkedRent = options.includeUnlinkedRent
    ? await unlinkedRentTenancy('Unlinked', 25)
    : null

  return { property, within, past, unlinkedRent }
}

/// A manager SCOPED TO ONE PROPERTY.
///
/// Not the portfolio-wide owner the first draft used. The rent roll is a
/// portfolio report by design, so a portfolio-wide actor sees every tenancy
/// every other spec has ever seeded in this shared database — and an
/// assertion like "1 selected" then counts other people's fixtures. Scoping
/// the staff member is what makes the counts mean anything, and it exercises
/// ROLE-01 on this screen for free.
///
/// `manager` holds both permissions this needs (`ledger.read` to see the
/// report, `message.send` to chase) and neither is privileged, so no MFA.
async function seedScopedManager(propertyId: string) {
  const email = `roll-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Rent Roll Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId },
  })
  return staff
}

async function seedTemplate(staffId: string) {
  const template = await prisma.messageTemplate.create({
    data: {
      name: `Rent reminder ${randomUUID().slice(0, 6)}`,
      kind: 'ROUTINE',
      subject: 'Rent is overdue at {{property.address}}',
      body: 'Hi {{tenant.first_name}}, {{balance.total}} is outstanding on your account.',
      createdByStaffId: staffId,
    },
  })
  templateIds.push(template.id)
  return template
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.describe('rent roll and delinquency aging (PAY-06)', () => {
  test('A TENANT INSIDE GRACE IS SHOWN AS LATE AND CANNOT BE CHASED', async ({ page }) => {
    const { property, within, past } = await seedPropertyWithTenancies()
    const staff = await seedScopedManager(property.id)
    await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/money/rent-roll')

    const withinRow = page.getByRole('row', { name: new RegExp(within.tenant.firstName) })
    const pastRow = page.getByRole('row', { name: new RegExp(past.tenant.firstName) })

    // Both are visibly delinquent — that is the report doing its job.
    await expect(withinRow.getByText('still within grace')).toBeVisible()
    await expect(pastRow.getByText('past grace')).toBeVisible()

    // Only one of them may be chased. No checkbox at all on the other, rather
    // than a disabled one: nothing the user could do would make it
    // selectable, so a control that looks available and refuses is worse.
    await expect(
      pastRow.getByRole('checkbox', { name: new RegExp(`Chase ${past.tenant.firstName}`) }),
    ).toBeVisible()
    await expect(
      withinRow.getByRole('checkbox', {
        name: new RegExp(`Chase ${within.tenant.firstName}`),
      }),
    ).toHaveCount(0)
  })

  test('ORDINARY RENT WITH NO CHARGE ROW IS AGED CORRECTLY — the gap this fix closes', async ({
    page,
  }) => {
    // Every other tenancy in this file is seeded with a Charge row, which is
    // realistic for a late fee or a proration but NOT for ordinary rent -
    // D-11/D-40 mint no monthly Charge for the subscription's own line, so
    // production posts an unlinked ledger entry with nothing dated on it at
    // all. Before this fix, `delinquencyFor` found no open charge and
    // reported the tenancy as current regardless of balance - silently
    // hiding the single most common form of delinquency in the product.
    const { property, unlinkedRent } = await seedPropertyWithTenancies({
      includeUnlinkedRent: true,
    })
    if (!unlinkedRent) throw new Error('seeded with includeUnlinkedRent: true')
    const staff = await seedScopedManager(property.id)
    await signIn(page, staff)
    await page.goto('/money/rent-roll')

    const row = page.getByRole('row', { name: new RegExp(unlinkedRent.tenant.firstName) })
    await expect(row.getByText('past grace')).toBeVisible()
    await expect(row.getByText('16–30 days')).toBeVisible()
    // AND IT IS CHASEABLE — the whole point of ageing it correctly in the
    // first place is that the bulk reminder can actually reach it.
    await expect(
      row.getByRole('checkbox', {
        name: new RegExp(`Chase ${unlinkedRent.tenant.firstName}`),
      }),
    ).toBeVisible()
  })

  test('"select all" selects everyone PAST GRACE, not every row', async ({ page }) => {
    const { property, past } = await seedPropertyWithTenancies()
    const staff = await seedScopedManager(property.id)
    await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/money/rent-roll')

    await page.getByRole('checkbox', { name: /Select all/ }).check()

    // One of the two tenancies, not both.
    await expect(page.getByRole('button', { name: /Send reminder to 1 selected/ })).toBeVisible()
    await expect(
      page.getByRole('checkbox', { name: new RegExp(`Chase ${past.tenant.firstName}`) }),
    ).toBeChecked()
  })

  test('sends the reminder to the selection and records the send', async ({ page }) => {
    const { property, past } = await seedPropertyWithTenancies()
    const staff = await seedScopedManager(property.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/money/rent-roll')

    await page.getByRole('checkbox', { name: /Select all/ }).check()
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: /Send reminder/ }).click()

    await expect(page.getByText(/Reminder sent to 1 tenant/)).toBeVisible()

    // The message the tenant actually gets carries the RENDERED merge fields.
    const delivery = await prisma.notificationDelivery.findFirst({
      where: { notification: { recipientId: past.tenant.id } },
      include: { notification: true },
    })
    expect(delivery).not.toBeNull()
    expect(delivery!.notification.body).toContain(past.tenant.firstName)
    expect(delivery!.notification.body).toContain('$1,500.00')
    // Never the raw token — R-049's renderer reports what it cannot fill and
    // this caller skips rather than sending it.
    expect(delivery!.notification.body).not.toContain('{{')

    // The audit row carries what was requested, what was sent, and why
    // anything was skipped.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: template.id, action: 'message.bulk_sent' },
    })
    expect(entry.after).toMatchObject({ requested: 1, sent: 1 })
  })

  test('DOUBLE-PRESSING SENDS ONCE', async ({ page }) => {
    const { property, past } = await seedPropertyWithTenancies()
    const staff = await seedScopedManager(property.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/money/rent-roll')
    await page.getByRole('checkbox', { name: /Select all/ }).check()
    await page.getByLabel('Template').selectOption(template.id)

    const countRows = () =>
      prisma.notification.count({
        where: { recipientId: past.tenant.id, templateKey: 'comms.managed_template' },
      })

    await page.getByRole('button', { name: /Send reminder/ }).click()
    await expect(page.getByText(/Reminder sent to 1 tenant/)).toBeVisible()
    const afterFirst = await countRows()

    await page.getByRole('button', { name: /Send reminder/ }).click()
    await expect(page.getByText(/Reminder sent to 1 tenant/)).toBeVisible()
    const afterSecond = await countRows()

    // COMPARED AGAINST ITSELF, not against 1. `notify()` writes one row per
    // CHANNEL — SMS, email and portal — so a single logical send is already
    // three rows, and asserting 1 would be asserting the channel count rather
    // than the idempotency. What must hold is that the second press adds
    // nothing: the key is the FACT (this lease, this template, this
    // property-local day), never the attempt.
    expect(afterFirst).toBeGreaterThan(0)
    expect(afterSecond).toBe(afterFirst)
  })

  test('the CSV export carries the aging and stays summable', async ({ page }) => {
    const { property, within, past } = await seedPropertyWithTenancies()
    await signIn(page, await seedScopedManager(property.id))

    const response = await page.request.get('/api/reports/rent-roll')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/csv')
    expect(response.headers()['content-disposition']).toContain('rent-roll-')

    const csv = await response.text()
    const rows = csv.split('\r\n')
    expect(rows[0]).toContain('Past grace')

    const pastLine = rows.find((line) => line.includes(past.tenant.firstName))!
    const withinLine = rows.find((line) => line.includes(within.tenant.firstName))!
    // The distinction survives the export, which is the whole reason the
    // column exists rather than a bare "days late".
    expect(pastLine).toContain(',yes,')
    expect(withinLine).toContain(',no,')
    // Bare numbers, not "$1,500.00" — a currency string imports as text and
    // cannot be summed, which defeats the point of a CSV.
    expect(pastLine).toContain('1500.00')
    expect(pastLine).not.toContain('$')
  })
})

test.afterAll(async () => {
  // LedgerEntry is append-only and its foreign keys are RESTRICT, so nothing
  // it points at can be deleted. Leases, charges and properties therefore
  // stay; only the rows carrying no ledger reference are removed, and the
  // roots are deactivated.
  await prisma.messageTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.lease.updateMany({
    where: { id: { in: leaseIds } },
    data: { status: 'ENDED' },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})
