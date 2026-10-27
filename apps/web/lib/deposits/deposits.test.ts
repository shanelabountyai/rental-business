import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { leaseBalanceAtStripeCents, leaseBalanceCents } from '@/lib/ledger/queries.ts'
import { upcomingCriticalDates } from '@/lib/reports/queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { finalizeDisposition, recordDepositRefund } from './actions.ts'

// The deposit disposition and its refund, from the ACTION down (D-303 and
// what followed it).
//
// `packages/core/ledger/disposition.test.ts` proves the arithmetic and the
// letter as pure functions and `e2e/deposit-disposition.spec.ts` drives the
// screen. Neither reaches what is stored and posted when a tenant's ledger is
// in CREDIT at move-out: the figure held on `Deposit`, the audit row, the
// task, and the ledger itself. Every tenancy here is built the way D-302
// leaves one - rent billed and paid through Stripe, then a ledger-only credit
// for the days not lived.

// Same three stubs, same reasoning, as workorders/chargeback-actions.test.ts:
// no request context, and the session and ONLY the session is faked, so
// `ledger.adjust` is a grant in the database rather than a string here.
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({ principal: { kind: 'staff', id: session.staffId, mfaVerified: true } }),
}))
// `finalizeDisposition` ends in a redirect to the letter, which outside a
// request has nowhere to go. A recognisable throw, so a test can tell "it
// finished" from "it refused".
class Redirected extends Error {}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))

const RENT = 150_000
// Move-out on the 20th of a 31-day month: 11 days paid for and not lived,
// 150000 * 11 / 31 = 53225.8, to the cent.
const CREDIT = 53_226

let entityId: string
let propertyId: string
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `deposits-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { orgId: 'org_0', name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Returned Rent Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { orgMemberships: { create: { orgId: 'org_0' } }, email: `deposits-${randomUUID()}@example.test`, name: 'Priya Owner' },
  })
  session.staffId = staff.id
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: owner.id, legalEntityId: entityId },
  })
})

afterAll(async () => {
  // Nothing here can be deleted: the ledger and the audit trail are
  // append-only and point at all of it. Deactivating the property is the
  // ownership marker the rest of the suite reads (R-109).
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: session.staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/**
 * An ended tenancy whose ledger is `CREDIT` in credit: one month billed and
 * paid through Stripe, then D-302's ledger-only credit.
 */
async function endedTenancy(options: { heldCents: number; deductionCents?: number; creditCents?: number }) {
  const creditCents = options.creditCents ?? CREDIT
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  const tenant = await prisma.tenant.create({
    data: { orgId: 'org_0',
      firstName: 'Noor',
      lastName: `Paidup-${randomUUID().slice(0, 6)}`,
      email: `noor-${randomUUID().slice(0, 8)}@example.test`,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ENDED',
      startsOn: new Date('2026-01-01'),
      rentCents: RENT,
      moveOutAt: new Date('2026-08-20T20:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId: tenant.id,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  const row = { propertyId, leaseId: lease.id, leasePayerId: payer.id, occurredAt: new Date() }
  const event = () => `evt_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  await prisma.ledgerEntry.createMany({
    data: [
      { ...row, type: 'CHARGE', amountCents: RENT, description: 'Rent, August', stripeEventId: event() },
      { ...row, type: 'PAYMENT', amountCents: -RENT, description: 'Payment', stripeEventId: event() },
      ...(creditCents > 0
        ? [{ ...row, type: 'CREDIT' as const, amountCents: -creditCents, description: 'Move-out credit' }]
        : []),
    ],
  })
  const deposit = await prisma.deposit.create({
    data: {
      propertyId,
      leaseId: lease.id,
      heldCents: options.heldCents,
      // Inside the critical-dates window whenever this runs.
      dispositionDueOn: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    },
  })
  if (options.deductionCents) {
    await prisma.depositDeduction.create({
      data: {
        propertyId,
        depositId: deposit.id,
        description: 'Replace the carpet',
        amountCents: options.deductionCents,
      },
    })
  }
  return { lease, deposit, unit }
}

async function finalize(depositId: string) {
  const form = new FormData()
  form.set('acknowledgeFinal', 'on')
  form.set('forwardingAddress', '12 Elsewhere St, Austin TX 78701')
  // Resolves only on a refusal; success is the redirect to the letter.
  const refusal = await finalizeDisposition(depositId, {}, form).catch((error: unknown) => {
    if (error instanceof Redirected) return null
    throw error
  })
  expect(refusal).toBeNull()
  return prisma.deposit.findUniqueOrThrow({ where: { id: depositId } })
}

function recordRefund(depositId: string) {
  const form = new FormData()
  form.set('method', 'OFFLINE_CHECK')
  form.set('paidOn', '2026-08-25')
  form.set('reference', 'chk 1042')
  return recordDepositRefund(depositId, {}, form)
}

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

describe('a disposition that returns a ledger credit (D-303, D-305)', () => {
  it('stores the credit on the deposit, beside the deposit refund and not inside it', async () => {
    const { deposit } = await endedTenancy({ heldCents: 200_000 })
    const sent = await finalize(deposit.id)

    expect(sent.refundedCents).toBe(200_000)
    expect(sent.creditRefundedCents).toBe(CREDIT)
  })

  it('records one disbursement for the deposit refund and the credit together', async () => {
    const { deposit } = await endedTenancy({ heldCents: 200_000 })
    await finalize(deposit.id)

    expect(await recordRefund(deposit.id)).toEqual({ notice: 'Refund recorded.' })

    const audited = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: deposit.id, action: 'deposit.refund_recorded' },
    })
    expect(audited.after).toMatchObject({
      amountCents: 200_000 + CREDIT,
      depositRefundCents: 200_000,
      creditRefundedCents: CREDIT,
    })
    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'deposit_refund_due', subjectId: deposit.id },
    })
    expect(task.status).toBe('DONE')
  })

  // The case with no screen before D-305: the deposit is spent to the cent
  // and the tenant is still owed their rent back.
  it('records a refund that is credit only, with none of the deposit coming back', async () => {
    const { deposit, unit } = await endedTenancy({ heldCents: 200_000, deductionCents: 200_000 })
    const sent = await finalize(deposit.id)
    expect(sent.refundedCents).toBe(0)
    expect(sent.creditRefundedCents).toBe(CREDIT)

    // Owed on the same statutory clock as a deposit refund, so it is on the
    // critical-dates report until it is paid.
    const due = () =>
      upcomingCriticalDates(scopeOf([propertyId]), new Date()).then((dates) =>
        dates.filter((d) => d.kind === 'DEPOSIT_DISPOSITION_DUE').map((d) => d.label),
      )
    const label = `Deposit refund due — ${unit.name}`
    expect(await due()).toContain(label)

    expect(await recordRefund(deposit.id)).toEqual({ notice: 'Refund recorded.' })

    const paid = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } })
    expect(paid.refundPaidOn).toEqual(new Date('2026-08-25T00:00:00Z'))
    const audited = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: deposit.id, action: 'deposit.refund_recorded' },
    })
    expect(audited.after).toMatchObject({
      amountCents: CREDIT,
      depositRefundCents: 0,
      creditRefundedCents: CREDIT,
    })
    expect(await due()).not.toContain(label)
  })

  it('still refuses to record a refund when nothing at all is coming back', async () => {
    const { deposit } = await endedTenancy({ heldCents: 200_000, deductionCents: 200_000, creditCents: 0 })
    await finalize(deposit.id)

    expect(await recordRefund(deposit.id)).toEqual({
      error: 'This disposition refunds nothing, so there is nothing to pay.',
    })
  })
})

// D-306. Until this, cutting the cheque wrote nothing to the ledger, so a
// former tenant who had been paid their credit went on showing as owed it.
describe('paying out a returned credit (D-306)', () => {
  const payouts = (leaseId: string) =>
    prisma.ledgerEntry.findMany({ where: { leaseId, type: 'ADJUSTMENT' } })

  it('posts one ledger-only entry that takes the credit off the ledger', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000 })
    await finalize(deposit.id)
    // The letter alone moves nothing: the money has not left yet.
    expect(await leaseBalanceCents(lease.id)).toBe(-CREDIT)

    expect(await recordRefund(deposit.id)).toEqual({ notice: 'Refund recorded.' })

    const posted = await payouts(lease.id)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ amountCents: CREDIT, stripeEventId: null, chargeId: null })
    expect(await leaseBalanceCents(lease.id)).toBe(0)
    // Stripe was told about neither the credit nor its payment, and its
    // invoice for the month is paid. Counting this row would report the
    // tenancy as CREDIT cents adrift every night from now on.
    expect(await leaseBalanceAtStripeCents(lease.id)).toBe(0)

    const audited = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'LedgerEntry', entityId: posted[0]!.id, action: 'ledger.adjusted' },
    })
    expect(audited.after).toMatchObject({
      ledgerOnly: true,
      amountCents: CREDIT,
      depositId: deposit.id,
    })
  })

  it('posts it once when the same refund is recorded again', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000 })
    await finalize(deposit.id)

    await recordRefund(deposit.id)
    expect(await recordRefund(deposit.id)).toEqual({
      error: 'This refund has already been recorded.',
    })

    expect(await payouts(lease.id)).toHaveLength(1)
    expect(await leaseBalanceCents(lease.id)).toBe(0)
  })

  // Two presses in the same instant both pass the read outside the
  // transaction. The per-lease lock and the re-read under it are what refuse
  // the second, not the check at the top of the action.
  it('posts it once when two recordings land together', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000 })
    await finalize(deposit.id)

    const results = await Promise.all([recordRefund(deposit.id), recordRefund(deposit.id)])

    expect(results.filter((r) => r.notice)).toHaveLength(1)
    expect(results.filter((r) => r.error)).toHaveLength(1)
    expect(await payouts(lease.id)).toHaveLength(1)
    expect(await leaseBalanceCents(lease.id)).toBe(0)
    expect(
      await prisma.auditLog.count({
        where: { entityId: deposit.id, action: 'deposit.refund_recorded' },
      }),
    ).toBe(1)
  })

  it('posts nothing for a refund that is deposit money only', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, creditCents: 0 })
    await finalize(deposit.id)

    expect(await recordRefund(deposit.id)).toEqual({ notice: 'Refund recorded.' })

    expect(await payouts(lease.id)).toHaveLength(0)
    expect(await leaseBalanceCents(lease.id)).toBe(0)
  })
})

// D-307. $2,000 held and a $532.26 credit throughout; only the deductions
// move. The arithmetic is proven in core - what is proven here is that the
// letter, the stored row, the invoice, the task and the LEDGER all say the
// same thing.
describe('a credit set against deductions beyond the deposit (D-307)', () => {
  const adjustments = (leaseId: string) =>
    prisma.ledgerEntry
      .findMany({ where: { leaseId, type: 'ADJUSTMENT' }, orderBy: { createdAt: 'asc' } })
      .then((rows) => rows.map((row) => row.amountCents))
  const invoicedBeyondDeposit = (depositId: string) =>
    prisma.charge.findUnique({ where: { depositId }, select: { amountCents: true } })
  const refundTask = (depositId: string) =>
    prisma.task.findFirst({ where: { type: 'deposit_refund_due', subjectId: depositId } })
  const letter = async (noticeId: string | null) =>
    (await prisma.notice.findUniqueOrThrow({ where: { id: noticeId! } })).bodyText

  it('credit smaller than the excess: invoices the difference and refunds nothing', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, deductionCents: 300_000 })
    const sent = await finalize(deposit.id)

    expect(sent).toMatchObject({
      appliedCents: 200_000,
      refundedCents: 0,
      creditAppliedCents: CREDIT,
      creditRefundedCents: 0,
    })
    // $1,000.00 beyond the deposit, less the $532.26 credit.
    expect(await invoicedBeyondDeposit(deposit.id)).toEqual({ amountCents: 46_774 })
    expect(await refundTask(deposit.id)).toBeNull()
    expect(await letter(sent.noticeId)).toContain('you still owe $467.74')

    // The credit is spent, and what the ledger shows owed is the invoice.
    expect(await adjustments(lease.id)).toEqual([CREDIT])
    expect(await leaseBalanceCents(lease.id)).toBe(46_774)
    // Which is also all Stripe holds: the one-off invoice just raised.
    expect(await leaseBalanceAtStripeCents(lease.id)).toBe(46_774)

    expect(await recordRefund(deposit.id)).toEqual({
      error: 'This disposition refunds nothing, so there is nothing to pay.',
    })
  })

  it('credit equal to the excess: nothing is invoiced, nothing refunded, and the ledger reads zero', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, deductionCents: 200_000 + CREDIT })
    const sent = await finalize(deposit.id)

    expect(sent).toMatchObject({ refundedCents: 0, creditAppliedCents: CREDIT, creditRefundedCents: 0 })
    expect(await invoicedBeyondDeposit(deposit.id)).toBeNull()
    expect(await refundTask(deposit.id)).toBeNull()
    expect(await adjustments(lease.id)).toEqual([CREDIT])
    expect(await leaseBalanceCents(lease.id)).toBe(0)
    expect(await leaseBalanceAtStripeCents(lease.id)).toBe(0)
  })

  it('credit larger than the excess: refunds the difference, and paying it zeroes the ledger', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, deductionCents: 220_000 })
    const sent = await finalize(deposit.id)

    // $200.00 beyond the deposit; $532.26 - $200.00 = $332.26 comes back.
    expect(sent).toMatchObject({
      appliedCents: 200_000,
      refundedCents: 0,
      creditAppliedCents: 20_000,
      creditRefundedCents: 33_226,
    })
    expect(await invoicedBeyondDeposit(deposit.id)).toBeNull()
    const text = await letter(sent.noticeId)
    expect(text).toContain('Credit applied to those deductions: $200.00.')
    expect(text).toContain('Total being refunded to you: $332.26.')
    const task = await refundTask(deposit.id)
    expect(task?.title).toContain('$332.26')
    expect(task?.title).not.toContain('$532.26')
    expect(await leaseBalanceCents(lease.id)).toBe(-33_226)

    expect(await recordRefund(deposit.id)).toEqual({ notice: 'Refund recorded.' })

    const audited = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: deposit.id, action: 'deposit.refund_recorded' },
    })
    expect(audited.after).toMatchObject({ amountCents: 33_226, creditRefundedCents: 33_226 })
    // One row for the part applied at the letter, one for the part paid out.
    expect(await adjustments(lease.id)).toEqual([20_000, 33_226])
    expect(await leaseBalanceCents(lease.id)).toBe(0)
    expect(await leaseBalanceAtStripeCents(lease.id)).toBe(0)
  })

  it('no excess: applies none of the credit and posts nothing until the refund is paid', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, deductionCents: 30_000 })
    const sent = await finalize(deposit.id)

    expect(sent).toMatchObject({
      appliedCents: 30_000,
      refundedCents: 170_000,
      creditAppliedCents: 0,
      creditRefundedCents: CREDIT,
    })
    expect(await invoicedBeyondDeposit(deposit.id)).toBeNull()
    expect(await adjustments(lease.id)).toEqual([])
    expect(await leaseBalanceCents(lease.id)).toBe(-CREDIT)
    expect((await refundTask(deposit.id))?.title).toContain('$2,232.26')
  })

  // The applied part is posted in the letter's own transaction, so the
  // re-read of `dispositionSentAt` under the per-lease lock is what stops a
  // second finalization posting it again. Two letters used to be possible.
  it('applies the credit once when two finalizations land together', async () => {
    const { deposit, lease } = await endedTenancy({ heldCents: 200_000, deductionCents: 220_000 })
    const press = () => {
      const form = new FormData()
      form.set('acknowledgeFinal', 'on')
      form.set('forwardingAddress', '12 Elsewhere St, Austin TX 78701')
      return finalizeDisposition(deposit.id, {}, form).catch((error: unknown) => {
        if (error instanceof Redirected) return null
        throw error
      })
    }
    const results = await Promise.all([press(), press()])

    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.find((r) => r !== null)).toEqual({
      error: 'This disposition has already been finalized.',
    })
    expect(await adjustments(lease.id)).toEqual([20_000])
    expect(await prisma.notice.count({ where: { leaseId: lease.id } })).toBe(1)
  })
})
