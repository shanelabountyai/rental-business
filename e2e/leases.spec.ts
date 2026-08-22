import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone, expectFocusSurvived } from './fixtures.ts'

// Lease records through the browser (LEASE-06, RISK-08, R-033).
//
// The status machine itself is proved exhaustively in
// packages/core/leases/leases.test.ts, and the intake Tasks against a real
// database in apps/web/lib/leases/intake.test.ts. What only a browser proves
// is here: that a PM can actually create a tenancy, put people on it, take it
// live, and that the inherited path surfaces its outstanding items where
// somebody will see them.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `lease-${unique}@example.test`,
      name: `Lease Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedUnit() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Lease LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      // The unit picker is portfolio-wide for an owner, so the property name
      // has to be unique enough to select by.
      name: `Lease House-${unique}`,
      addressLine1: '3 Tenancy Terrace',
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
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Rosa',
      lastName: `Lease-${unique}`,
      email: `rosa-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  return { property, unit, tenant, unique }
}

async function seedLease(
  seed: Awaited<ReturnType<typeof seedUnit>>,
  overrides: {
    status?: string
    origin?: string
    withTenant?: boolean
    isMonthToMonth?: boolean
  } = {},
) {
  const lease = await prisma.lease.create({
    data: {
      propertyId: seed.property.id,
      unitId: seed.unit.id,
      status: (overrides.status ?? 'DRAFT') as never,
      origin: (overrides.origin ?? 'APPLICATION') as never,
      depositTransferStatus: overrides.origin === 'INHERITED' ? 'UNKNOWN' : 'NOT_APPLICABLE',
      startsOn: new Date('2026-01-01'),
      endsOn: overrides.isMonthToMonth ? null : new Date('2026-12-31'),
      isMonthToMonth: overrides.isMonthToMonth ?? false,
      rentCents: 150_000,
      depositCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  if (overrides.withTenant !== false) {
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: seed.tenant.id, isPrimary: true },
    })
  }
  return lease
}

/// The id the create redirect landed on. Read from the URL rather than
/// looked up by unit: the redirect is the product telling us which row it
/// made, and a query would be guessing at the same answer.
async function capturedLeaseId(page: import('@playwright/test').Page) {
  // NOT /\/leases\/[a-z0-9]+$/ - that also matches the CURRENT url,
  // "/leases/new" itself, which resolves the wait instantly and hands back
  // "new" as the id. Exactly the trap maintenance-phone-log.spec.ts already
  // documents for its own create redirect.
  await page.waitForURL(/\/leases\/(?!new$)[a-z0-9]+$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  leaseIds.push(id)
  return id
}

/// Polled, not read once: the test's Prisma client is a separate connection
/// from the one the server action committed through, and against Neon's
/// pooled connections a read immediately afterwards can land a beat early -
/// the gap properties.spec.ts already documents for its own create flow.
async function leaseRow(id: string) {
  await expect.poll(() => prisma.lease.count({ where: { id } })).toBe(1)
  return prisma.lease.findUniqueOrThrow({ where: { id } })
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
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

test.afterAll(async () => {
  // By UNIT, not by the ids this file happened to collect: a test that
  // failed before registering the lease it created would otherwise leave a
  // row behind, and the next line's Unit delete is RESTRICT-blocked by
  // exactly that.
  const strayLeases = await prisma.lease.findMany({
    where: { unitId: { in: unitIds } },
    select: { id: true },
  })
  const allLeaseIds = [...new Set([...leaseIds, ...strayLeases.map((l) => l.id)])]
  await prisma.task.deleteMany({ where: { subjectId: { in: allLeaseIds } } })
  await prisma.guarantor.deleteMany({ where: { leaseId: { in: allLeaseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: allLeaseIds } } })
  // Activating a lease opens billing (R-034), so a LeasePayer pins the lease
  // - and a LedgerEntry pins the payer, with a RESTRICT that correctly
  // refuses. So only the leases carrying NO ledger rows can go; the ones
  // this spec's ledger tests wrote against stay, deactivated by their
  // property below like every other append-only remnant.
  const pinned = new Set(
    (
      await prisma.ledgerEntry.findMany({
        where: { leaseId: { in: allLeaseIds } },
        select: { leaseId: true },
        distinct: ['leaseId'],
      })
    ).map((row) => row.leaseId),
  )
  const removable = allLeaseIds.filter((id) => !pinned.has(id))
  await prisma.leasePayer.deleteMany({ where: { leaseId: { in: removable } } })
  // Ending a tenancy auto-opens a turnover project (R-072), and
  // `TurnoverProject.leaseId` is Restrict - so the lease this file's own
  // "offers nothing further on a lease that is over" test ENDS has a turn
  // hanging off it and no ledger rows to pin it, and the delete below failed
  // on the FK. Found by R-084, which ran this spec alongside its own; the
  // failure lands on whichever test finished last in the worker, which is
  // why it read as two unrelated lifecycle tests breaking.
  await prisma.turnoverProject.deleteMany({ where: { leaseId: { in: removable } } })
  await prisma.lease.deleteMany({ where: { id: { in: removable } } })
  const stillLeased = new Set(
    (
      await prisma.lease.findMany({
        where: { unitId: { in: unitIds } },
        select: { unitId: true },
        distinct: ['unitId'],
      })
    ).map((row) => row.unitId),
  )
  await prisma.unit.deleteMany({
    where: { id: { in: unitIds.filter((id) => !stillLeased.has(id)) } },
  })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  // Deactivated, not deleted - lease writes leave append-only audit rows
  // carrying these ids.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('creating a tenancy', () => {
  test('creates a draft, adds somebody, and takes it live — occupying the unit', async ({
    page,
  }) => {
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2026-03-01')
    await page.getByRole('textbox', { name: 'Ends on' }).fill('2027-02-28')
    await page.getByLabel('Monthly rent (dollars)').fill('1650')
    await page.getByLabel('Deposit held (dollars)').fill('1650')
    // Deliberately left blank - see the assertion below.
    await page.getByRole('button', { name: 'Create draft lease' }).click()

    const leaseId = await capturedLeaseId(page)
    const lease = await leaseRow(leaseId)
    expect(lease.status).toBe('DRAFT')
    expect(lease.rentCents).toBe(165_000)
    expect(lease.origin).toBe('APPLICATION')
    // BLANK STAYS NULL, and null means the lease is silent about returned
    // payments, which means no fee (R-039a). Not 0, which would be a lease
    // that expressly charges nothing - a different sentence, and one nobody
    // wrote here. `assessNsfFee` reads this exact distinction, so a `?? 0`
    // creeping into the action would start charging a fee on every lease
    // signed before the field existed.
    expect(lease.nsfFeeCents).toBeNull()
    // Every lease created before the deposit type existed is a cash deposit
    // by construction - nobody could have chosen otherwise - so that is what
    // the column defaults to (R-041).
    expect(lease.depositArrangement).toBe('CASH')

    // Nobody is on it yet, so activation is not even offered - the machine
    // decides what the UI shows, rather than a button appearing and then
    // refusing.
    await expect(
      page.getByRole('button', { name: 'Make this lease active' }),
    ).toHaveCount(0)
    await expect(page.getByText(/cannot go live without at least one person/)).toBeVisible()

    await page
      .getByLabel('Add somebody to the lease')
      .selectOption({ label: `Rosa ${seed.tenant.lastName} (${seed.tenant.email})` })
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText(/· primary/)).toBeVisible()

    await page.getByRole('button', { name: 'Make this lease active' }).click()
    await expect(page.getByText('active', { exact: false }).first()).toBeVisible()

    const live = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(live.status).toBe('ACTIVE')
    expect(live.activatedAt).not.toBeNull()

    // Activating occupies the unit NOW - R-009's nightly job is the backstop
    // for a lease nobody touches, not the only path.
    const unit = await prisma.unit.findUniqueOrThrow({ where: { id: seed.unit.id } })
    expect(unit.status).toBe('OCCUPIED')

    // And it opens billing (D-11, R-034). Polled: provisioning runs after
    // the transaction commits, deliberately, so activation is never undone
    // by a billing provider being unreachable.
    await expect
      .poll(() => prisma.leasePayer.count({ where: { leaseId: lease.id } }))
      .toBe(1)
    const payer = await prisma.leasePayer.findFirstOrThrow({
      where: { leaseId: lease.id },
    })
    expect(payer.stripeCustomerId).toMatch(/^cus_/)
    expect(payer.stripeSubscriptionId).toMatch(/^sub_/)
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible()
    // Labelled honestly - the ids are Stripe-shaped on purpose, so the
    // label is the only thing telling a simulator apart from the real thing.
    await expect(page.getByText(/not real Stripe/)).toBeVisible()
  })

  test('refuses a month-to-month lease carrying an end date', async ({ page }) => {
    // R-009's auto-make-ready job keys on exactly that column - an MTM lease
    // with an end date would have its unit flipped out from under a tenant
    // who still lives there.
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2026-03-01')
    await page.getByLabel('Monthly rent (dollars)').fill('1200')
    await page.getByRole('checkbox', { name: /Month-to-month/ }).check()
    // The end-date field is cleared and no longer required once MTM is
    // ticked - proving the client-side rule matches the server's.
    await expect(page.getByRole('textbox', { name: 'Ends on (not used)' })).toHaveValue('')

    await page.getByRole('button', { name: 'Create draft lease' }).click()
    const lease = await leaseRow(await capturedLeaseId(page))
    expect(lease.isMonthToMonth).toBe(true)
    expect(lease.endsOn).toBeNull()
  })
})

test.describe('the lifecycle', () => {
  test('records notice WITHOUT ending the tenancy', async ({ page }) => {
    // The core design call of this item: a tenancy under notice is still
    // running, so notice is a fact about an active lease, never a status.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByText('Record notice to end the tenancy').click()
    await expectFocusSurvived(page, 'opening “Record notice to end the tenancy” — a lease disclosure')
    await page.getByLabel('Who gave notice').selectOption('TENANT')
    await page.getByLabel('Date notice was given').fill('2026-06-01')
    // 44 days out - clear of TX's 30-day noticeToVacateDays, so this stays
    // the clean path; R-066's short-notice warning has its own test below.
    await page.getByLabel('Date the tenancy actually ends').fill('2026-07-15')
    await page
      .getByLabel('Forwarding address')
      .fill('900 Departure Ave, Austin, TX 78701')
    await page.getByRole('button', { name: 'Record notice' }).click()

    await expect(page.getByText(/still running until it ends/)).toBeVisible()

    const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(after.noticeGivenAt).not.toBeNull()
    expect(after.noticeGivenBy).toBe('TENANT')
    expect(after.noticeEffectiveOn).not.toBeNull()
    expect(after.noticeForwardingAddress).toBe('900 Departure Ave, Austin, TX 78701')
    // Unchanged. That is the whole point.
    expect(after.status).toBe('ACTIVE')
  })

  test('DEMANDS a reason to terminate, and records it', async ({ page }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    await prisma.unit.update({ where: { id: seed.unit.id }, data: { status: 'OCCUPIED' } })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    const reason = page.getByLabel('Why is this tenancy being cut short?')
    await expect(reason).toBeVisible()
    await reason.fill('Mutual release, tenant relocating for work')
    await page.getByRole('button', { name: 'Terminate this tenancy' }).click()

    await expect(page.getByText(/Mutual release, tenant relocating/)).toBeVisible()

    const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(after.status).toBe('TERMINATED')
    expect(after.terminationReason).toContain('Mutual release')
    expect(after.moveOutAt).not.toBeNull()

    // Its OWN audit action, so recordAudit itself refuses a termination
    // with no reason (REASON_REQUIRED).
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: lease.id, action: 'lease.terminated' },
    })
    expect(entry.reason).toContain('Mutual release')

    // Coming off a running tenancy frees the unit.
    const unit = await prisma.unit.findUniqueOrThrow({ where: { id: seed.unit.id } })
    expect(unit.status).toBe('MAKE_READY')
  })

  test('offers nothing further on a lease that is over', async ({ page }) => {
    // A tenancy that restarts is a NEW lease. Reopening this one would
    // rewrite the dates and rent a deposit disposition is defended with.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ENDED' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await expect(page.getByText(/A tenancy that restarts is a new lease/)).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Make this lease active' }),
    ).toHaveCount(0)
  })
})

test.describe('inherited at acquisition (RISK-08)', () => {
  test('surfaces all three outstanding items with their consequences', async ({
    page,
  }) => {
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page.getByLabel('Inherited at acquisition').check()
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2024-05-01')
    await page.getByLabel('Monthly rent (dollars)').fill('2000')
    await page.getByRole('checkbox', { name: /Month-to-month/ }).check()
    await page.getByRole('button', { name: 'Create draft lease' }).click()
    const lease = await leaseRow(await capturedLeaseId(page))
    expect(lease.origin).toBe('INHERITED')
    // UNKNOWN, never the NOT_APPLICABLE default - that single assignment is
    // what puts it on the list instead of letting it look settled.
    expect(lease.depositTransferStatus).toBe('UNKNOWN')

    await expect(page.getByText(/3 things outstanding/)).toBeVisible()
    await expect(page.getByText(/cannot charge move-out damage/)).toBeVisible()
    await expect(page.getByText(/while the seller still answers the phone/)).toBeVisible()

    // The outstanding items are real Tasks in the one queue (D-9).
    await expect
      .poll(() => prisma.task.count({ where: { subjectId: lease.id } }))
      .toBe(3)
  })

  test('records the deposit position, including that the seller kept it', async ({
    page,
  }) => {
    // "The seller kept it" is an ANSWER, not an absence - we are very likely
    // still liable for it either way.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'MONTH_TO_MONTH', origin: 'INHERITED' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByLabel('What happened to the deposit?').selectOption('NOT_TRANSFERRED')
    await page
      .getByLabel('How you established that')
      .fill('Seller confirmed by email; settlement statement shows no credit')
    await page.getByRole('button', { name: 'Record it' }).click()

    await expect(page.getByText(/2 things outstanding/)).toBeVisible()

    const after = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(after.depositTransferStatus).toBe('NOT_TRANSFERRED')
    expect(after.depositTransferNote).toContain('settlement statement')
  })

  test('shows no intake panel at all on an ordinary lease', async ({ page }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await expect(page.getByText(/Inherited at acquisition/)).toHaveCount(0)
  })
})

test.describe('parties', () => {
  test('adds a guarantor as a distinct role, never an occupant', async ({ page }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'DRAFT' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByText('Add a guarantor').click()
    await page.getByLabel('First name').fill('Marta')
    await page.getByLabel('Last name').fill('Guarantor')
    await page.getByLabel('Email').fill('marta@example.test')
    await page.getByRole('button', { name: 'Add guarantor' }).click()

    await expect(page.getByText('Marta Guarantor')).toBeVisible()

    const guarantor = await prisma.guarantor.findFirstOrThrow({
      where: { leaseId: lease.id },
    })
    expect(guarantor.firstName).toBe('Marta')
    // LEASE-06's "no portal access" is STRUCTURAL: a Guarantor is not a
    // Tenant, and the portal authenticates Tenants. No flag to get wrong.
    expect(
      await prisma.tenant.count({ where: { email: 'marta@example.test' } }),
    ).toBe(0)
    expect(await prisma.leaseTenant.count({ where: { leaseId: lease.id } })).toBe(1)
  })

  test('refuses to empty a RUNNING tenancy', async ({ page }) => {
    // Rent owed by nobody, a unit occupied by nobody. RISK-10's
    // roommate-change flow handles a departing tenant; this is not it.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByRole('button', { name: 'Remove' }).click()

    await expect(page.getByText(/needs at least one person on it/)).toBeVisible()
    expect(await prisma.leaseTenant.count({ where: { leaseId: lease.id } })).toBe(1)
  })
})

test.describe('the ledger (PAY-03, PAY-09, D-11)', () => {
  test('renders the statement with a running balance a judge could read', async ({
    page,
  }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: seed.property.id,
        payerType: 'TENANT',
        tenantId: seed.tenant.id,
      },
    })
    // Projected rows, as R-034's pipeline would have written them.
    await prisma.ledgerEntry.create({
      data: {
        propertyId: seed.property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'February rent',
        occurredAt: new Date('2026-02-01T12:00:00Z'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId: seed.property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        type: 'PAYMENT',
        amountCents: -120_000,
        description: 'Part payment',
        occurredAt: new Date('2026-02-05T12:00:00Z'),
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)

    const ledger = page.getByLabel('Ledger')
    await expect(ledger.getByText('February rent')).toBeVisible()
    // Plain language, not enum codes - PAY-09 wants this readable.
    await expect(ledger.getByText(/^Charged/)).toBeVisible()
    await expect(ledger.getByText(/^Paid/)).toBeVisible()
    // $1,500 charged less $1,200 paid leaves $300 - and the running balance
    // is what makes the statement a story rather than a list.
    await expect(page.getByText('$300.00 owed')).toBeVisible()
    await expect(ledger.getByRole('cell', { name: '$300.00' })).toBeVisible()
  })

  test('shows a CREDIT balance as the tenant’s money, not a debt', async ({ page }) => {
    // "−$50 owed" would read as a debt. An overpayment is a real state.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: seed.property.id,
        payerType: 'TENANT',
        tenantId: seed.tenant.id,
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId: seed.property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        type: 'PAYMENT',
        amountCents: -5_000,
        description: 'Overpayment',
        occurredAt: new Date('2026-02-05T12:00:00Z'),
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)
    await expect(page.getByText('$50.00 in credit')).toBeVisible()
  })

  test('says nothing is posted rather than showing an empty table', async ({ page }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'DRAFT' })
    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)
    await expect(page.getByText(/Nothing posted yet/)).toBeVisible()
    await expect(page.getByText('Nothing owed')).toBeVisible()
  })
})

test.describe('the subscription lifecycle (R-036, D-11)', () => {
  test('ending a tenancy CANCELS its subscription', async ({ page }) => {
    // The branch that matters most: a tenancy that ended must stop billing.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    await prisma.unit.update({ where: { id: seed.unit.id }, data: { status: 'OCCUPIED' } })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: seed.property.id,
        payerType: 'TENANT',
        tenantId: seed.tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeAmountCents: 150_000,
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)
    await page.getByRole('button', { name: 'Record that the tenancy ended' }).click()

    await expect
      .poll(async () => {
        const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
        return after.lastSyncAction
      })
      .toBe('cancelled')
  })

  test('a rent change reaches Stripe', async ({ page }) => {
    // Otherwise the tenant keeps being billed the old amount indefinitely.
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: seed.property.id,
        payerType: 'TENANT',
        tenantId: seed.tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeAmountCents: 150_000,
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)

    await page.getByRole('spinbutton', { name: 'Monthly rent (dollars)' }).fill('1725')
    await page.getByRole('button', { name: 'Save terms' }).click()

    await expect
      .poll(async () => {
        const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
        return after.stripeAmountCents
      })
      .toBe(172_500)
  })

  test('the lease page offers a re-sync and says which provider it used', async ({
    page,
  }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE' })
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: seed.property.id,
        payerType: 'TENANT',
        tenantId: seed.tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        stripeAmountCents: 150_000,
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/leases/${lease.id}`)

    await page.getByRole('button', { name: 'Re-sync with Stripe' }).click()
    await expect(page.getByText(/Already in step/)).toBeVisible()
  })
})

test.describe('deposits as liabilities (PAY-07, R-041)', () => {
  test('REFUSES a surety bond that also holds cash', async ({ page }) => {
    // The failure this prevents happens at move-out, in both directions: a
    // tenant chased to collect a refund nobody owes them, or an owner
    // believing they hold money that was never taken. Refused by the form AND
    // by a database CHECK, because the same contradiction reached by an
    // import or a fixture causes the same confusion.
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2026-03-01')
    await page.getByRole('textbox', { name: 'Ends on' }).fill('2027-02-28')
    await page.getByLabel('Monthly rent (dollars)').fill('1650')
    await page.getByLabel('Deposit type').selectOption('SURETY_BOND')
    await page.getByLabel('Deposit held (dollars)').fill('1650')
    await page.getByRole('button', { name: 'Create draft lease' }).click()

    await expect(page.getByText(/surety bond, so no cash deposit is held/i)).toBeVisible()
    // And nothing was written.
    expect(await prisma.lease.count({ where: { unitId: seed.unit.id } })).toBe(0)
  })

  test('records a surety bond as no cash held, and says so on the lease', async ({ page }) => {
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2026-03-01')
    await page.getByRole('textbox', { name: 'Ends on' }).fill('2027-02-28')
    await page.getByLabel('Monthly rent (dollars)').fill('1650')
    await page.getByLabel('Deposit type').selectOption('SURETY_BOND')
    await page.getByLabel('Deposit held (dollars)').fill('0')
    await page.getByRole('button', { name: 'Create draft lease' }).click()

    const leaseId = await capturedLeaseId(page)
    const lease = await leaseRow(leaseId)
    expect(lease.depositArrangement).toBe('SURETY_BOND')
    expect(lease.depositCents).toBe(0)

    // Scoped to the description list, not the page: the same words are the
    // label of the <option> in the edit form further down, and a bare
    // getByText matches both. The claim being made is about what the lease
    // SUMMARY says, so say that.
    await expect(
      page.locator('dd').filter({ hasText: 'Surety bond — no cash held' }),
    ).toBeVisible()
  })

  test('a cash deposit is labelled as held on trust, NOT as income', async ({ page }) => {
    // A deposit shown beside the rent as a bare number invites treating it as
    // revenue, which is the mistake several states wrote escrow laws about.
    const seed = await seedUnit()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/leases/new')
    await page
      .getByLabel('Unit')
      .selectOption({ label: `${seed.property.name} — ${seed.unit.name}` })
    await page.getByLabel('Starts on').fill('2026-03-01')
    await page.getByRole('textbox', { name: 'Ends on' }).fill('2027-02-28')
    await page.getByLabel('Monthly rent (dollars)').fill('1650')
    await page.getByLabel('Deposit held (dollars)').fill('1650')
    await page.getByRole('button', { name: 'Create draft lease' }).click()

    await capturedLeaseId(page)
    await expect(page.getByText(/held on trust — not income/)).toBeVisible()
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the list, the new-lease form and the detail page have no violations', async ({
    page,
  }) => {
    const seed = await seedUnit()
    const lease = await seedLease(seed, { status: 'ACTIVE', origin: 'INHERITED' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    for (const [name, url] of [
      ['list', '/leases'],
      ['new', '/leases/new'],
      ['detail', `/leases/${lease.id}`],
    ] as const) {
      await page.goto(url)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations, name).toEqual([])
    }
  })
})
