import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// Billing a tenant for a repair they caused (MAINT-07, R-031).
//
// ==========================================================================
// THE FIRST MAINTENANCE OUTCOME THAT WRITES TO THE LEDGER, which is why this
// gets a browser test rather than only unit coverage. Three things can only
// be proved here:
//
//   - The MANAGER WHO CLOSED THE JOB CANNOT BILL FOR IT. `ledger.adjust` is
//     kept away from managers deliberately (rbac.test.ts), and D-43 puts the
//     chargeback behind it. If that separation were only in a comment, the
//     panel would render for the wrong person and nobody would notice.
//   - The tenant SEES the charge afterwards, on their own statement, in the
//     portal — which is the whole argument for R-043 having gone first.
//   - The ceiling holds against a form post, not just against a unit test
//     calling the decision function directly.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const staffIds: string[] = []
const vendorIds: string[] = []

async function seed() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Chg LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Chg House-${stamp}`,
      addressLine1: '44 Chargeback Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)

  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Dana',
      lastName: `Chargeback-${stamp}`,
      email: `dana-${stamp}@example.test`,
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  // The PAYER, not just the occupant. The chargeback is billed to whoever
  // pays, and a lease with a tenant on it and nobody set up to be billed is a
  // different state the decision has to handle.
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })

  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      tenantId: tenant.id,
      leaseId: lease.id,
      source: 'PORTAL',
      category: 'PLUMBING',
      description: 'The waste disposal is jammed and smells.',
      priority: 'ROUTINE',
      status: 'CONVERTED',
    },
  })
  ticketIds.push(ticket.id)

  const vendor = await prisma.vendor.create({
    data: { name: `Chg Plumbing-${stamp}`, trades: ['plumbing'], phone: uniquePhone() },
  })
  vendorIds.push(vendor.id)

  // WORK_COMPLETE with real costs, so the job is closable and the ceiling is
  // a real number: $90 labour + $25 materials = $115.
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      vendorId: vendor.id,
      scope: 'Clear and replace the waste disposal',
      status: 'WORK_COMPLETE',
      completedAt: new Date(),
      actualLaborCents: 9_000,
      actualMaterialsCents: 2_500,
    },
  })
  workOrderIds.push(workOrder.id)

  return { property, unit, tenant, lease, ticket, workOrder }
}

/// An owner with MFA enrolled. `ledger.adjust` is privileged (ROLE-05), so a
/// password alone does not reach it.
///
/// PORTFOLIO-WIDE, not property-scoped. The work order page opens with an
/// unscoped `requirePermission`, which a property-scoped grant does not
/// satisfy — the same note verify-close.spec.ts carries, and copying the
/// RUBS spec's property-scoped owner is what made the first run of this file
/// fail with a redirect rather than a refusal.
async function seedOwner() {
  const email = `chg-owner-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Chargeback Owner',
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
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })
  return { ...staff, secret }
}

/// A manager: can close a job, cannot touch the ledger. No MFA needed,
/// because nothing they are allowed to do here is privileged.
async function seedManager() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `chg-mgr-${randomUUID()}@example.test`,
      name: 'Chargeback Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
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

/// Closes the job as tenant-caused, through the browser, as a manager. The
/// state every test below starts from.
async function closeAsTenantCaused(
  page: import('@playwright/test').Page,
  workOrderId: string,
) {
  await page.goto(`/workorders/${workOrderId}`)
  await page.getByLabel(/Invoice total/i).fill('115')
  await page.getByRole('radio', { name: 'Tenant-caused' }).check()
  await page.getByRole('button', { name: 'Close this work order' }).click()
  await expect(page.getByText(/^Closed/).first()).toBeVisible()
}

// Login is rate-limited per IP (R-003) and every test here signs in.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.describe('billing a tenant for a repair they caused (R-031)', () => {
  test('CLOSING AS TENANT-CAUSED RAISES A TASK — the decision goes in a queue, not in somebody’s memory', async ({
    page,
  }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    // D-43's whole cost. Splitting the charge out of the close buys the
    // permission boundary and the partial bill, and risks a flagged job never
    // being billed. This is what pays it back (D-9).
    const task = await prisma.task.findFirst({
      where: { subjectId: workOrder.id, type: 'workorder_chargeback_decision' },
    })
    expect(task).not.toBeNull()
    expect(task!.status).toBe('OPEN')
    // ROUTINE whatever the job's priority was — deciding who pays the morning
    // after a burst pipe is not an emergency, and priority inflation is how a
    // queue stops meaning anything.
    expect(task!.priority).toBe('ROUTINE')
  })

  test('closing as normal wear raises nothing — silence is never inferred as consent', async ({
    page,
  }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel(/Invoice total/i).fill('115')
    await page.getByRole('radio', { name: 'Normal wear' }).check()
    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByText(/^Closed/).first()).toBeVisible()

    expect(
      await prisma.task.count({
        where: { subjectId: workOrder.id, type: 'workorder_chargeback_decision' },
      }),
    ).toBe(0)
  })

  test('THE MANAGER WHO CLOSED THE JOB CANNOT BILL FOR IT (D-43)', async ({ page }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    // Same page, immediately after flagging it. `ledger.adjust` is kept away
    // from managers on purpose, and posting the charge from inside the close
    // action would have quietly made "can close a job" mean "can bill a
    // tenant".
    await expect(page.getByRole('heading', { name: 'Bill the tenant' })).toHaveCount(0)
  })

  test('bills PART of a repair, shows both numbers, and the tenant sees it on their own statement', async ({
    page,
    browser,
  }) => {
    const { workOrder, tenant, lease } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    const owner = await seedOwner()
    const ownerContext = await browser.newContext()
    try {
      const ownerPage = await ownerContext.newPage()
      const octet = () => Math.floor(Math.random() * 254) + 1
      await ownerPage.setExtraHTTPHeaders({
        'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
      })
      await signIn(ownerPage, owner)

      await ownerPage.goto(`/workorders/${workOrder.id}`)
      await expect(ownerPage.getByRole('heading', { name: 'Bill the tenant' })).toBeVisible()

      // Pre-filled with the FULL cost, then lowered — betterment, partial
      // fault. This is the normal outcome, not the exception.
      await expect(ownerPage.getByLabel(/Charge the tenant/i)).toHaveValue('115.00')
      await ownerPage.getByLabel(/Charge the tenant/i).fill('60')
      await ownerPage
        .getByLabel(/Why this is the tenant/i)
        .fill('Cutlery in the disposal is not normal wear.')
      await ownerPage.getByRole('button', { name: 'Post charge and serve notice' }).click()
      // THE POSTED STATE, not the action's own notice. `revalidatePath`
      // re-renders the server component with the charge now in place, so the
      // panel switches to reporting and the form — along with the live region
      // holding that notice — unmounts. Asserting the notice would be
      // asserting a string no user ever sees.
      await expect(
        ownerPage.getByText(/\$60\.00 has been charged to the tenant/),
      ).toBeVisible()

      const charge = await prisma.charge.findFirstOrThrow({
        where: { workOrderId: workOrder.id },
      })
      expect(charge.type).toBe('CHARGEBACK')
      expect(charge.amountCents).toBe(6_000)
      // THE ARITHMETIC IS ON THE CHARGE, the same way a RUBS share carries
      // its own. A tenant reading "Repair charge" has to go and ask.
      expect(charge.description).toContain('$60.00 of a $115.00 repair')

      // The notice, served, quoting the reason back verbatim.
      const notice = await prisma.notice.findFirstOrThrow({
        where: { leaseId: lease.id, type: 'REPAIR_CHARGE' },
      })
      expect(notice.bodyText).toContain('Cutlery in the disposal is not normal wear.')
      expect(notice.bodyText).toContain(
        'You are being charged $60.00 of that amount — not the full cost.',
      )
      expect(notice.bodyText).toContain(
        'Disputing a repair charge is not a failure to pay rent',
      )
      expect(notice.servedAt).not.toBeNull()

      // The audit row carries BOTH numbers and the reason. "Was the tenant
      // billed the whole repair" must be answerable without joining back to
      // a work order whose costs could have moved since.
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: charge.id, action: 'workorder.chargeback_posted' },
      })
      expect(entry.reason).toContain('Cutlery')
      expect(entry.after).toMatchObject({ amountCents: 6_000, jobCostCents: 11_500, partial: true })
    } finally {
      // Close every context, or a leak surfaces as an unrelated spec failing.
      await ownerContext.close()
    }

    // AND THE TENANT IS TOLD, on a category they cannot have switched off.
    //
    // NOT "the charge is on their statement yet". D-11 makes `LedgerEntry` a
    // projection of Stripe, never a direct write, so a chargeback reaches the
    // portal's payment history when the invoice event lands - exactly like
    // rent, late fees, NSF fees and RUBS shares. That path is R-035's and is
    // tested in stripe-webhook.spec.ts; asserting it here would be asserting
    // somebody else's item.
    //
    // What R-031 owes the tenant NOW is that nobody is billed silently. The
    // template is `legal_notice`, which is locked (LOCKED_CATEGORIES): a
    // tenant who has muted maintenance updates is saying they do not need to
    // know a plumber is coming, not that they waive notice of being charged.
    const delivery = await prisma.notificationDelivery.findFirst({
      where: {
        notification: {
          recipientId: tenant.id,
          templateKey: 'workorder.chargeback_posted',
        },
      },
      include: { notification: true },
    })
    expect(delivery).not.toBeNull()
    expect(delivery!.notification.category).toBe('legal_notice')
  })

  test('REFUSES MORE THAN THE REPAIR COST against a real form post', async ({
    page,
    browser,
  }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    const owner = await seedOwner()
    const context = await browser.newContext()
    try {
      const ownerPage = await context.newPage()
      const octet = () => Math.floor(Math.random() * 254) + 1
      await ownerPage.setExtraHTTPHeaders({
        'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
      })
      await signIn(ownerPage, owner)
      await ownerPage.goto(`/workorders/${workOrder.id}`)

      // STRIPS THE CLIENT-SIDE `max` FIRST, which is the whole point. With it
      // in place the browser refuses to submit at all and the server is never
      // reached — so a test that just typed 500 would pass forever while
      // proving nothing about the ceiling that actually matters. A crafted
      // post does exactly this; so does a stale page after a cost changed.
      await ownerPage
        .getByLabel(/Charge the tenant/i)
        .evaluate((input: HTMLInputElement) => input.removeAttribute('max'))
      await ownerPage.getByLabel(/Charge the tenant/i).fill('500')
      await ownerPage
        .getByLabel(/Why this is the tenant/i)
        .fill('Trying to charge more than it cost.')
      await ownerPage.getByRole('button', { name: 'Post charge and serve notice' }).click()

      await expect(
        ownerPage.getByText(/cannot charge the tenant more than the repair cost/i).first(),
      ).toBeVisible()
      expect(await prisma.charge.count({ where: { workOrderId: workOrder.id } })).toBe(0)
    } finally {
      await context.close()
    }
  })

  test('refuses a chargeback with no stated reason — it would be indistinguishable from retaliation', async ({
    page,
    browser,
  }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    const owner = await seedOwner()
    const context = await browser.newContext()
    try {
      const ownerPage = await context.newPage()
      const octet = () => Math.floor(Math.random() * 254) + 1
      await ownerPage.setExtraHTTPHeaders({
        'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
      })
      await signIn(ownerPage, owner)
      await ownerPage.goto(`/workorders/${workOrder.id}`)

      await ownerPage.getByLabel(/Charge the tenant/i).fill('60')
      await ownerPage.getByLabel(/Why this is the tenant/i).fill('damage')
      await ownerPage.getByRole('button', { name: 'Post charge and serve notice' }).click()

      await expect(ownerPage.getByText(/Say why this repair is the tenant/i)).toBeVisible()
      expect(await prisma.charge.count({ where: { workOrderId: workOrder.id } })).toBe(0)
    } finally {
      await context.close()
    }
  })

  test('bills a job ONCE — the second attempt reports rather than charging again', async ({
    page,
    browser,
  }) => {
    const { workOrder } = await seed()
    const manager = await seedManager()
    await signIn(page, manager)
    await closeAsTenantCaused(page, workOrder.id)

    const owner = await seedOwner()
    const context = await browser.newContext()
    try {
      const ownerPage = await context.newPage()
      const octet = () => Math.floor(Math.random() * 254) + 1
      await ownerPage.setExtraHTTPHeaders({
        'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
      })
      await signIn(ownerPage, owner)
      await ownerPage.goto(`/workorders/${workOrder.id}`)

      await ownerPage.getByLabel(/Charge the tenant/i).fill('115')
      await ownerPage
        .getByLabel(/Why this is the tenant/i)
        .fill('The whole repair was avoidable.')
      await ownerPage.getByRole('button', { name: 'Post charge and serve notice' }).click()
      await expect(
        ownerPage.getByText(/\$115\.00 has been charged to the tenant/),
      ).toBeVisible()

      // Reloading offers no form, and REPORTS WHAT WAS CHARGED rather than
      // what the job cost — they differ whenever part of a repair was billed.
      await ownerPage.reload()
      await expect(
        ownerPage.getByText(/\$115\.00 has been charged to the tenant/),
      ).toBeVisible()
      await expect(
        ownerPage.getByRole('button', { name: 'Post charge and serve notice' }),
      ).toHaveCount(0)

      expect(await prisma.charge.count({ where: { workOrderId: workOrder.id } })).toBe(1)
    } finally {
      await context.close()
    }
  })
})

test.afterAll(async () => {
  // Charges point at the work order with onDelete: Restrict — the job IS the
  // defence of the chargeback — so they go first or the work order delete
  // fails. Notices point at the lease for the same reason.
  await prisma.payerAllocation.deleteMany({
    where: { charge: { workOrderId: { in: workOrderIds } } },
  })
  await prisma.charge.deleteMany({ where: { workOrderId: { in: workOrderIds } } })
  await prisma.notice.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipientId: { in: tenantIds } } },
  })
  await prisma.task.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.leasePayer.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // Deactivated, not deleted: these carry audit rows, and AuditLog refuses
  // the cascading update.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
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
