import { randomUUID } from 'node:crypto'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BillingProvider } from '@/lib/billing/adapter.ts'
import { postChargeback } from './chargeback-actions.ts'

// Billing a tenant for a repair they caused, from the ACTION down (MAINT-07,
// R-031; R-130 for the clock).
//
// ==========================================================================
// WHAT THIS COVERS THAT THE TWO EXISTING FILES CANNOT.
//
// `packages/core/workorders/chargeback.test.ts` proves the decision and the
// notice text as pure functions, and `e2e/chargeback.spec.ts` drives the
// panel in a browser. Between them the permission, the refusals, the partial
// arithmetic and the happy path are covered. What neither can reach is the
// ORDERING this action's own doc comment promises - "the tenant is never
// billed silently" - because every step of it is a failure or a race a
// browser has no way to cause:
//
//   - the payment provider throwing, which must leave the Charge standing;
//   - a tenancy with no payment method, which must still be charged and told;
//   - two presses landing in the same instant, which the database index and
//     not the read-then-write check is what refuses;
//   - a hand-made POST carrying an amount no `<input type="number">` sends;
//   - the due date, which is money (`daysPastDue` counts grace from it) and
//     which R-130 fixed with nothing asserting it since.
// ==========================================================================

// `revalidatePath` throws outside a request context, so no success path is
// reachable without this. Same stub, same reasoning as
// vendors/complete-gate.test.ts.
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))

// The audit trail records the caller's IP and user agent off the request, and
// there is no request here. A real `Headers` rather than a stub object, so the
// `x-forwarded-for` splitting in `currentAuditActor` runs for real against the
// empty case - which is also what a scheduled job hits.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

// The session, and ONLY the session. Everything downstream of it stays real -
// `currentActor` still loads the StaffUser, the assignment and the role from
// Postgres, and `requirePermission` still runs the real RBAC decision against
// them. Faking the Actor instead would have made `ledger.adjust` a string in
// this file rather than a grant in the database, which is the half worth
// proving.
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({
    // Privileged (ROLE-03/ROLE-05): `ledger.adjust` is on
    // PRIVILEGED_PERMISSIONS, so an unproved second factor is refused.
    principal: { kind: 'staff', id: session.staffId, mfaVerified: true },
  }),
}))

// The provider seam, wrapping the REAL selector rather than replacing it, so
// the ordinary path still runs the simulator the rest of the suite runs.
// Only the failure is invented.
const billing = vi.hoisted(() => ({ fails: false }))
vi.mock('@/lib/billing/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/provider.ts')>()
  return {
    ...actual,
    getBillingProvider: () =>
      billing.fails
        ? ({
            name: 'unreachable',
            addInvoiceItem: async () => {
              throw new Error('provider unreachable')
            },
          } as unknown as BillingProvider)
        : actual.getBillingProvider(),
  }
})

let entityId: string
let propertyId: string
let unitId: string
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `chargeback-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Broken Sash Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      // Six hours behind UTC in March, which is what makes the due-date test
      // below able to tell the two clocks apart.
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id

  const staff = await prisma.staffUser.create({
    data: { email: `chargeback-${randomUUID()}@example.test`, name: 'Priya Owner' },
  })
  session.staffId = staff.id
  // `owner` is the seeded role that holds `ledger.adjust` - `manager`
  // deliberately does not (rbac.test.ts asserts that). Read rather than
  // created: roles are data (D-5) and inventing one here would test a
  // permission set this product does not ship.
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: owner.id, legalEntityId: entityId },
  })
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: session.staffId }, data: { active: false } })
  // Deactivating the property is also what marks this file's notification
  // debris as finished, per R-109 - the rows cannot be deleted, `Notification`
  // being append-only.
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/** A closed, tenant-caused, invoiced job with a live tenancy to bill. */
async function billableJob(options: { withPaymentMethod: boolean }) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Dara',
      lastName: `Sash-${randomUUID().slice(0, 6)}`,
      email: `dara-${randomUUID().slice(0, 8)}@example.test`,
      // No phone, deliberately: a literal would collide with the routing
      // fixture rule, and email alone is enough to prove the tenant was told.
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 180_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId: tenant.id,
      stripeCustomerId: options.withPaymentMethod
        ? `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`
        : null,
    },
  })
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      leaseId: lease.id,
      tenantId: tenant.id,
      source: 'PORTAL',
      category: 'WINDOWS_DOORS',
      description: 'Bathroom window sash snapped off in my hand',
      status: 'CLOSED',
    },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId: ticket.id,
      scope: 'Replace bathroom window sash',
      priority: 'ROUTINE',
      status: 'CLOSED',
      tenantCaused: true,
      invoiceCents: 41_200,
      closedAt: new Date('2026-03-04T15:00:00.000Z'),
    },
  })
  return { workOrderId: workOrder.id, leaseId: lease.id, tenantId: tenant.id }
}

function form(amountDollars: string, reason = 'Sash snapped when it was forced past the stop.') {
  const data = new FormData()
  data.set('amountDollars', amountDollars)
  data.set('reason', reason)
  return data
}

describe('postChargeback', () => {
  it('CHARGES, SERVES AND TELLS even when the payment provider is down', async () => {
    // The invariant the function's own doc comment states: the Charge is
    // written first because it is the thing the database can make idempotent,
    // and a provider failure after it leaves a visible, recoverable row -
    // never a message promising a charge that was never posted.
    const job = await billableJob({ withPaymentMethod: true })
    billing.fails = true
    let result
    try {
      result = await postChargeback(job.workOrderId, {}, form('150'))
    } finally {
      billing.fails = false
    }

    expect(result.error).toBeUndefined()
    expect(result.notice).toContain('$150.00')

    const charge = await prisma.charge.findFirstOrThrow({
      where: { workOrderId: job.workOrderId },
    })
    expect(charge.amountCents).toBe(15_000)
    expect(charge.type).toBe('CHARGEBACK')
    // The recoverable state, not a rollback: the tenant owes it and the
    // ledger says so, exactly as `assessNsfFee` leaves it.
    expect(charge.stripeInvoiceItemId).toBeNull()
    // The arithmetic on the charge itself - what stops a tenant having to
    // call to find out what "$150.00" was a share of.
    expect(charge.description).toContain('$150.00 of a $412.00')

    // Served, and told, despite the failure.
    const notice = await prisma.notice.findFirstOrThrow({
      where: { leaseId: job.leaseId, type: 'REPAIR_CHARGE' },
    })
    expect(notice.servedByStaffId).toBe(session.staffId)
    // The EMAIL row specifically, and its address. `notify` fans one
    // notification out to a row per channel, so a bare count would pass on
    // the PORTAL row alone - which reaches a tenant only if they sign in.
    const told = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'TENANT',
        recipientId: job.tenantId,
        templateKey: 'workorder.chargeback_posted',
        channel: 'EMAIL',
      },
    })
    expect(told.toAddress).toContain('@example.test')
    expect(told.body).toContain('$150.00')
  }, 30_000)

  it('records BOTH numbers on the audit row — the first question in a dispute', async () => {
    const job = await billableJob({ withPaymentMethod: true })
    const result = await postChargeback(job.workOrderId, {}, form('412'))
    expect(result.error).toBeUndefined()

    const charge = await prisma.charge.findFirstOrThrow({
      where: { workOrderId: job.workOrderId },
    })
    // The ordinary path still runs the simulator, so this is the real push.
    expect(charge.stripeInvoiceItemId).not.toBeNull()

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Charge', entityId: charge.id, action: 'workorder.chargeback_posted' },
    })
    const after = entry.after as Record<string, unknown>
    // "Was the tenant billed the whole repair?" must be answerable from the
    // audit row alone - the work order's costs can move after the fact.
    expect(after.amountCents).toBe(41_200)
    expect(after.jobCostCents).toBe(41_200)
    expect(after.partial).toBe(false)
    expect(entry.reason).toContain('Sash snapped')
  }, 30_000)

  it('charges a tenancy with NO payment method, and says so rather than implying it was sent', async () => {
    const job = await billableJob({ withPaymentMethod: false })
    const result = await postChargeback(job.workOrderId, {}, form('99.50'))

    expect(result.error).toBeUndefined()
    expect(result.notice).toContain('no payment method')
    const charge = await prisma.charge.findFirstOrThrow({
      where: { workOrderId: job.workOrderId },
    })
    expect(charge.amountCents).toBe(9_950)
    expect(charge.stripeInvoiceItemId).toBeNull()
  }, 30_000)

  it('DATES THE CHARGE IN THE PROPERTY\'S CALENDAR, not UTC\'s (R-130)', async () => {
    // 8pm on 5 March in Houston is 02:00 on the 6th in UTC. This is a due
    // date, not a label: `daysPastDue` counts grace and the late fee from it,
    // so reading the UTC clock moved money by a day on every evening
    // chargeback. Fixed in R-130 with nothing asserting it until now.
    const job = await billableJob({ withPaymentMethod: false })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-03-06T02:00:00.000Z'))
    try {
      const result = await postChargeback(job.workOrderId, {}, form('150'))
      expect(result.error).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }

    const charge = await prisma.charge.findFirstOrThrow({
      where: { workOrderId: job.workOrderId },
    })
    expect(utcToBusinessDate(charge.dueOn)).toBe('2026-03-05')
  }, 30_000)

  it('BILLS ONCE when two presses land together — the index, not the read', async () => {
    // The refusal a browser cannot produce. Both submits read the context
    // before either writes, so both pass `existingChargeId` and both reach
    // the insert; the partial unique index is the only thing between the
    // tenant and two charges for one repair. Asserted as the invariant rather
    // than as a branch, because either ordering is a correct outcome and only
    // the index makes both of them true.
    const job = await billableJob({ withPaymentMethod: true })
    const results = await Promise.all([
      postChargeback(job.workOrderId, {}, form('200')),
      postChargeback(job.workOrderId, {}, form('200')),
    ])

    const charges = await prisma.charge.findMany({ where: { workOrderId: job.workOrderId } })
    expect(charges).toHaveLength(1)
    expect(results.filter((r) => r.notice)).toHaveLength(1)
    expect(results.filter((r) => r.error?.includes('already been billed'))).toHaveLength(1)
  }, 30_000)

  it('writes NO charge for an amount no number input could have sent', async () => {
    // The trust boundary. `<input type="number">` cannot send these; a
    // hand-made POST can. Note WHICH guard is doing the work:
    // `chargebackDecision`'s `Number.isInteger`, not the action's own
    // `Number.isFinite` - dropping that one leaves all six of these green,
    // because `isInteger` is the stricter test and already refuses NaN and
    // Infinity. What this asserts that core's own test cannot is the
    // consequence: no Charge row reaches the database.
    const job = await billableJob({ withPaymentMethod: true })
    for (const junk of ['later', 'Infinity', '-50', '']) {
      const result = await postChargeback(job.workOrderId, {}, form(junk))
      expect(result.error, junk).toBeDefined()
      expect(result.notice, junk).toBeUndefined()
    }
    expect(await prisma.charge.count({ where: { workOrderId: job.workOrderId } })).toBe(0)
  }, 30_000)
})
