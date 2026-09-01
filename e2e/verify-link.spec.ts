import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, expectFocusSurvived, uniquePhone } from './fixtures.ts'

// The tenant answers without signing in (MAINT-07, COMM-02, R-032c).
//
// THE ASSERTION THAT MATTERS: the tenant in these tests has NO EMAIL. Before
// this item the verification SMS linked into the portal, which sits behind
// `requireTenant` and redirects to an EMAIL-ONLY login with no return-to — so
// this exact person, the persona R-021 was built for, could not answer at all.
// Every test below runs in a context with no session of any kind.

const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const vendorIds: string[] = []

async function seedAnsweredJob() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Verify LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Verify House-${stamp}`,
      addressLine1: '11 Reply Road',
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
  const tenant = await prisma.tenant.create({
    // NO EMAIL, deliberately. A phone and nothing else.
    data: {
      firstName: 'Ray',
      lastName: `NoEmail-${stamp}`,
      phone: uniquePhone(),
      email: null,
    },
  })
  tenantIds.push(tenant.id)
  const vendor = await prisma.vendor.create({
    data: { name: `Trade-${stamp}`, trades: ['PLUMBING'] },
  })
  vendorIds.push(vendor.id)

  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      tenantId: tenant.id,
      source: 'SMS',
      category: 'PLUMBING',
      description: 'Water coming through the ceiling in the hall',
      priority: 'URGENT',
      status: 'TRIAGED',
    },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      vendorId: vendor.id,
      scope: 'Trace leak above hall ceiling, repair and make good',
      priority: 'URGENT',
      status: 'WORK_COMPLETE',
      completedAt: new Date(),
    },
  })

  // The link the SMS would carry, minted through CORE rather than by
  // importing `issueVerifyLink`. The app module declares `server-only`, which
  // Vitest aliases away and Playwright does not — importing it here fails at
  // runtime with "Cannot find module 'server-only'".
  //
  // The row below mirrors `issueVerifyLink` exactly; the shapes are pinned
  // together by apps/web/lib/portal/verify-link.test.ts, which exercises the
  // real function against the real verifier. This spec is about what the
  // tenant can DO once they have the link.
  const minted = mintToken('TENANT_VERIFY')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_VERIFY',
      tokenHash: minted.tokenHash,
      subjectType: 'WorkOrder',
      subjectId: workOrder.id,
      expiresAt: minted.expiresAt,
      metadata: { tenantId: tenant.id, round: 1 },
    },
  })
  const token = minted.token

  return { workOrder, ticket, tenant, vendor, token }
}

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: { in: vendorIds } }, data: { active: false } })
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

test.describe('answering without an account', () => {
  test('a tenant with NO EMAIL confirms the repair in one tap', async ({ page }) => {
    const { workOrder, vendor, token } = await seedAnsweredJob()

    await page.goto(`/verify/${token}`)

    // No redirect to a login. That single assertion is the item.
    await expect(page).toHaveURL(new RegExp(`/verify/${token}$`))
    await expect(page.getByRole('heading', { name: 'Was this fixed?' })).toBeVisible()
    // Their OWN words, not the internal scope.
    await expect(page.getByText('Water coming through the ceiling')).toBeVisible()

    // R-141: and WHAT WE DID, which this page never said. A tenant answering
    // three days later was being asked to confirm a visit the page declined
    // to describe. Both halves have to be here at once - the report they
    // recognise AND the work it is asking them to sign off.
    await expect(page.getByRole('heading', { name: 'What we did' })).toBeVisible()
    await expect(page.getByText('Trace leak above hall ceiling')).toBeVisible()
    await expect(page.getByText(`${vendor.name} marked this finished on`)).toBeVisible()

    await page.getByRole('button', { name: /Yes, it.s fixed/ }).click()

    await expect(page.getByText(/closed it off/i)).toBeVisible()
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('VERIFIED')
  })

  test('“still a problem” reopens it and keeps the note', async ({ page }) => {
    const { workOrder, token } = await seedAnsweredJob()

    await page.goto(`/verify/${token}`)
    await page.getByText('Add a note (optional)').click()
    await expectFocusSurvived(page, 'opening the optional-note disclosure')
    await page
      .getByLabel('Anything you want us to know?')
      .fill('Ceiling is dry but the stain is still spreading')
    await page.getByRole('button', { name: /No, it.s still a problem/ }).click()

    await expect(page.getByText(/reopened it/i)).toBeVisible()
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('SUBMITTED')
    expect(after.reopenCount).toBe(1)

    const row = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(row.comment).toContain('stain is still spreading')
  })

  test('the answer is attributed to the TENANT, not to nobody', async ({ page }) => {
    // `audit()` resolves its actor from a session and there is none here, so
    // the first version of this recorded SYSTEM / anonymous — on the one row
    // whose whole value is that a named tenant said it.
    const { workOrder, tenant, token } = await seedAnsweredJob()

    await page.goto(`/verify/${token}`)
    await page.getByRole('button', { name: /Yes, it.s fixed/ }).click()
    await expect(page.getByText(/closed it off/i)).toBeVisible()

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: workOrder.id, action: 'workorder.verified' },
    })
    expect(entry.actorType).toBe('TENANT')
    expect(entry.actorRef).toBe(tenant.id)
  })

  test('a second tap cannot change the answer', async ({ page }) => {
    const { workOrder, token } = await seedAnsweredJob()

    await page.goto(`/verify/${token}`)
    await page.getByRole('button', { name: /Yes, it.s fixed/ }).click()
    await expect(page.getByText(/closed it off/i)).toBeVisible()

    // Reopening the link is allowed - it is multi-use, because a tenant who
    // gets distracted must not find it dead. The ANSWER is what is once-only.
    await page.goto(`/verify/${token}`)
    // "Thanks", not "Already answered" — this same branch is what a tenant
    // sees the instant they tap, because a server action re-renders the page.
    await expect(page.getByRole('heading', { name: 'Thanks' })).toBeVisible()
    await expect(page.getByRole('button', { name: /still a problem/ })).toHaveCount(0)

    expect(
      await prisma.workOrderVerification.count({ where: { workOrderId: workOrder.id } }),
    ).toBe(1)
  })

  test('a forged token is a dead end that says what to do', async ({ page }) => {
    await page.goto('/verify/not-a-real-token')

    await expect(page.getByRole('heading', { name: /isn.t working/ })).toBeVisible()
    // Never a bare "invalid link" — a dead end with no next step sends
    // somebody to the phone, which is what this item exists to remove.
    await expect(page.getByText(/call the office/i)).toBeVisible()
  })

  test('accessibility', async ({ page }) => {
    const { token } = await seedAnsweredJob()
    await page.goto(`/verify/${token}`)

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
