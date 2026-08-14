import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { expectFocusSurvived, uniquePhone } from './fixtures.ts'

// Charges beside the rent (PAY-08, R-042).
//
// Two screens, one item. The lease's monthly charges - pet rent, a flat
// utility fee - and the property's utility bills, where a single-meter bill
// is split across the units and charged on.
//
// The assertion that matters most on the second one: THE SPLIT IS SHOWN
// BEFORE IT IS CHARGED, and charging is a second press. One press that
// recorded and billed would put every tenant's invoice at the mercy of a typo
// in an amount field, and a RUBS charge is the one a tenant is most likely to
// query.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seed() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Meter LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Meter House-${stamp}`,
      addressLine1: '3 Single Meter Lane',
      city: 'Houston',
      // Texas, whose shipped rule permits RUBS. The refusal path is covered
      // in the unit tests against an invented state, because inventing one
      // here would change what every other spec's `rulesFor` resolves.
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
    },
  })
  propertyIds.push(property.id)

  const leases = []
  for (const [name, squareFeet] of [
    ['A', 1_000],
    ['B', 3_000],
  ] as const) {
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: `${name}-${stamp}`, squareFeet, status: 'OCCUPIED' },
    })
    const tenant = await prisma.tenant.create({
      data: { firstName: 'Kit', lastName: `${name}-${stamp}`, phone: uniquePhone() },
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
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
    // A PROVISIONED PAYER, because both features push to a subscription that
    // has to exist. Without it the product does the right thing — a charge
    // agreed before billing was opened waits for it — and the spec would be
    // asserting the waiting path while claiming to assert the billing one.
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: property.id,
        payerType: 'TENANT',
        tenantId: tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    leases.push(lease)
  }

  // MFA enrolled and an OWNER assignment: splitting a bill is gated on
  // `ledger.adjust`, the privileged permission R-004 reserves for money with
  // no processor on the other side, and privileged permissions need a
  // verified second factor.
  const email = `rubs-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Meter Owner',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId: property.id },
  })

  return { property, leases, staff: { ...staff, secret } }
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

// Login is rate-limited per IP (R-003) and every test here signs in. Without
// a distinct address the later ones are throttled, and it surfaces as a
// sign-in that never navigates.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Deactivated, never deleted: Charge rows are referenced by append-only
  // audit and ledger keys, all of them RESTRICT.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({
    where: { id: { in: entityIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('monthly charges beside the rent', () => {
  test('adds pet rent, shows what the tenant will read, and stops it again', async ({ page }) => {
    const { leases, staff } = await seed()
    const lease = leases[0]!
    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)

    await expect(
      page.getByRole('heading', { name: 'Monthly charges beside the rent' }),
    ).toBeVisible()

    // A `<summary>`, like every other disclosure since R-099 - it survives
    // its own activation, which a `useState` toggle does not.
    await page.getByText('Add a monthly charge').click()
    await expectFocusSurvived(page, 'opening the add-a-monthly-charge disclosure')

    await page.getByLabel('What is it?').selectOption('PET_RENT')
    await page.getByLabel('What was agreed?').fill('Two cats')
    await page.getByLabel('How much a month?').fill('35')
    await page.getByRole('button', { name: 'Add this charge' }).click()

    // THE SENTENCE THE TENANT READS ON EVERY INVOICE. "Pet rent" alone has to
    // be taken on trust; this can be checked against what was agreed.
    // `exact: true` — the same sentence appears in the confirmation notice and
    // inside the "Stop …" disclosure trigger, which is the point: core writes
    // it once and every surface repeats it verbatim.
    await expect(
      page.getByText('Pet rent — Two cats — $35.00/month', { exact: true }),
    ).toBeVisible()

    const created = await prisma.recurringCharge.findFirstOrThrow({
      where: { leaseId: lease.id },
    })
    expect(created.amountCents).toBe(3_500)
    // On the subscription, not merely recorded in our own tables.
    expect(created.stripeSubscriptionItemId).not.toBeNull()

    await page.getByText('Stop Pet rent — Two cats — $35.00/month').click()
    await page.getByRole('button', { name: /^Stop \$35\.00 a month$/ }).click()

    await expect(page.getByText('· stopped')).toBeVisible()
    const stopped = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    // Deactivated, NOT deleted. "Why was I charged $35 a month for two years"
    // is a question a deleted row cannot answer.
    expect(stopped.active).toBe(false)
    expect(stopped.stripeSubscriptionItemId).toBeNull()
  })

  test('refuses a charge with nothing saying what it is for', async ({ page }) => {
    // The label IS the evidence. "Pet rent $35" on a tenant's invoice for
    // three years, with nothing saying which pet was agreed to, is the
    // dispute this field exists to prevent.
    //
    // The blank label rather than the zero amount, deliberately: the amount
    // input carries `min="0.01"`, so the browser refuses a zero before the
    // request is made, and a spec asserting the server's wording there would
    // be waiting for a response that is never sent. The server's own refusals
    // are unit-tested in packages/core/billing/recurring.test.ts.
    const { leases, staff } = await seed()
    const lease = leases[0]!
    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)

    await page.getByText('Add a monthly charge').click()
    await page.getByLabel('How much a month?').fill('35')
    await page.getByRole('button', { name: 'Add this charge' }).click()

    // `.first()`: the refusal appears twice on purpose — once in the form's
    // alert and once beside the field it is about, which is what a
    // `role="alert"` next to the input is for.
    await expect(page.getByText('Say what this is for').first()).toBeVisible()
    expect(await prisma.recurringCharge.count({ where: { leaseId: lease.id } })).toBe(0)
  })
})

test.describe('splitting a utility bill', () => {
  test('records the bill, then charges the split on as a second press', async ({ page }) => {
    const { property, leases, staff } = await seed()
    await signIn(page, staff)
    await page.goto(`/properties/${property.id}/utilities`)

    await expect(page.getByRole('heading', { name: 'Utility bills' })).toBeVisible()

    await page.getByText('Record a bill').click()
    await expectFocusSurvived(page, 'opening the record-a-bill disclosure')

    await page.getByLabel('Utility', { exact: true }).selectOption('WATER')
    await page.getByLabel('Period from').fill('2026-07-01')
    await page.getByLabel('Period to').fill('2026-07-31')
    await page.getByLabel('Amount on the bill').fill('412')
    await page.getByLabel('How is it split?').selectOption('SQUARE_FEET')
    await page.getByRole('button', { name: 'Record this bill' }).click()

    // RECORDED, NOT CHARGED. Nobody has been billed yet.
    await expect(page.getByText('Bill recorded.')).toBeVisible()
    const bill = await prisma.utilityBill.findFirstOrThrow({
      where: { propertyId: property.id },
    })
    expect(bill.allocatedAt).toBeNull()
    expect(await prisma.charge.count({ where: { utilityBillId: bill.id } })).toBe(0)

    // The second press. What confirms it is the RECORD replacing the button,
    // not a notice: the split, who charged it on and when. That is deliberate
    // — a transient toast is the wrong confirmation for the one action in
    // this product that bills every tenant at a property at once.
    await page.getByRole('button', { name: 'Charge $412.00 on to the tenants' }).click()
    await expect(page.getByText('Charged on', { exact: false })).toBeVisible()

    const charges = await prisma.charge.findMany({
      where: { utilityBillId: bill.id },
      orderBy: { amountCents: 'asc' },
    })
    // 1,000 and 3,000 sq ft of 4,000. The parts sum exactly to the bill.
    expect(charges.map((charge) => charge.amountCents)).toEqual([10_300, 30_900])
    expect(charges.map((charge) => charge.leaseId).sort()).toEqual(
      leases.map((lease) => lease.id).sort(),
    )

    // THE ARITHMETIC IS ON THE SCREEN, as the tenant will read it on their
    // own invoice.
    await expect(
      page.getByText('Water 2026-07-01 to 2026-07-31 — $412.00 × 1,000/4,000 sq ft = $103.00'),
    ).toBeVisible()

    // And it cannot be charged again - the button is gone, replaced by the
    // record of what happened.
    await expect(
      page.getByRole('button', { name: 'Charge $412.00 on to the tenants' }),
    ).toHaveCount(0)
  })

  test('refuses a split it cannot compute, and charges nobody', async ({ page }) => {
    // A unit with no floor area recorded cannot be split on floor area.
    // Inventing an average would put a number on a tenant's invoice that no
    // one could defend.
    const { property, staff } = await seed()
    const stamp = randomUUID().slice(0, 6)
    await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: `NoFigure-${stamp}`,
        squareFeet: null,
        status: 'OCCUPIED',
      },
    })

    await signIn(page, staff)
    await page.goto(`/properties/${property.id}/utilities`)

    await page.getByText('Record a bill').click()
    await page.getByLabel('Period from').fill('2026-08-01')
    await page.getByLabel('Period to').fill('2026-08-31')
    await page.getByLabel('Amount on the bill').fill('500')
    await page.getByLabel('How is it split?').selectOption('SQUARE_FEET')
    await page.getByRole('button', { name: 'Record this bill' }).click()

    await page.getByRole('button', { name: 'Charge $500.00 on to the tenants' }).click()

    // Names the unit and the fix, rather than failing with a code.
    await expect(page.getByText(new RegExp(`NoFigure-${stamp}`))).toBeVisible()
    const bill = await prisma.utilityBill.findFirstOrThrow({
      where: { propertyId: property.id, amountCents: 50_000 },
    })
    expect(await prisma.charge.count({ where: { utilityBillId: bill.id } })).toBe(0)
    // Not marked allocated, so recording the missing figure and trying again
    // works rather than being permanently refused.
    expect(bill.allocatedAt).toBeNull()
  })
})
