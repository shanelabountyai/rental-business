import { randomUUID } from 'node:crypto'
import { hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniquePhone } from './fixtures.ts'

// The zero-login vendor journey, end to end (D-6, D-16, MAINT-03, R-025).
//
// A vendor is an UNAUTHENTICATED party holding a bearer token, so this spec
// spends most of its weight on what the link refuses: a forged token, one
// pointed at another job's document, and - the one that matters most - a
// reassigned vendor's link that has not expired and cannot be un-sent.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []
const documentIds: string[] = []
const accessCodeIds: string[] = []

async function createStaff(roleKey = 'owner') {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `vl-${unique}@example.test`,
      name: `Vendor Link Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedJob(options: { withAccessCode?: boolean; withTenant?: boolean } = {}) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `VL LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `VL House-${unique}`,
      addressLine1: '11 Vendor Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })

  let ticketId: string | null = null
  let tenantPhone: string | null = null
  if (options.withTenant !== false) {
    const tenant = await prisma.tenant.create({
      data: { firstName: 'Vera', lastName: `Tenant-${unique}`, phone: uniquePhone() },
    })
    tenantPhone = tenant.phone
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
    const ticket = await prisma.ticket.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        leaseId: lease.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'Kitchen tap drips constantly.',
        priority: 'URGENT',
      },
    })
    ticketIds.push(ticket.id)
    ticketId = ticket.id
  }

  const vendor = await prisma.vendor.create({
    data: { name: `Vendor-${unique}`, trades: ['plumbing'], phone: uniquePhone() },
  })
  vendorIds.push(vendor.id)

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId,
      vendorId: vendor.id,
      status: 'ASSIGNED',
      scope: 'Replace the kitchen tap cartridge.',
      priority: 'URGENT',
    },
  })
  workOrderIds.push(workOrder.id)

  if (options.withAccessCode) {
    const code = await prisma.accessCode.create({
      data: {
        unitId: unit.id,
        type: 'LOCKBOX',
        label: 'Front door lockbox',
        sealedCode: sealSecret('4821', 'access-code'),
        version: 1,
      },
    })
    accessCodeIds.push(code.id)
  }

  return { property, unit, vendor, workOrder, ticketId, tenantPhone }
}

/// Signs in as staff and dispatches, returning the vendor's live token.
/// Goes through the real UI rather than calling issueVendorLink directly,
/// so the dispatch button and the link it mints are both exercised.
async function dispatchAndCaptureToken(
  page: import('@playwright/test').Page,
  workOrderId: string,
  propertyId: string,
) {
  const staff = await createStaff()
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')

  await page.goto(`/workorders/${workOrderId}`)
  await page.getByRole('button', { name: /Send the vendor their link/ }).click()

  // The RAW token never leaves the mint, by design - only its hash is
  // stored. The message carrying it went to the logging channel adapter
  // (D-15), so the test reads it back from the notification body, which is
  // also a real assertion that the link actually reached the vendor's
  // message rather than being dropped.
  //
  // Polls for the NOTIFICATION, not for dispatchedAt: the action sets
  // dispatchedAt inside its transaction and only then calls notify(), so a
  // poll on dispatchedAt returns while the message still does not exist.
  // Scoped to THIS property because these specs run in parallel and a
  // global "newest /vendor/ link" would hand one test another's token.
  await expect
    .poll(
      () =>
        prisma.notification.count({
          where: { propertyId, body: { contains: `/vendor/` } },
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0)

  const notification = await prisma.notification.findFirstOrThrow({
    where: { propertyId, body: { contains: `/vendor/` } },
    orderBy: { createdAt: 'desc' },
  })
  const match = /\/vendor\/([A-Za-z0-9_-]+)/.exec(notification.body)
  expect(match, 'the dispatch message should carry a /vendor/ link').not.toBeNull()
  return match![1]!
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { propertyId: { in: propertyIds } } },
  })
  // Notification itself is APPEND-ONLY (trigger-enforced, R-016) - the rows
  // stay, exactly as AuditLog's do. Deleting the deliveries is enough to
  // leave nothing pending for another suite's dispatcher to pick up.
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.accessCode.deleteMany({ where: { id: { in: accessCodeIds } } })
  await prisma.eventConsumption.deleteMany({
    where: { event: { propertyId: { in: propertyIds } } },
  })
  await prisma.outboxEvent.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
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

test.describe('the vendor journey', () => {
  test('opens the job with no account at all, accepts, and uploads an invoice', async ({
    page,
  }) => {
    const { workOrder, vendor, tenantPhone } = await seedJob()
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    // A BRAND NEW browser context with no cookies - the vendor is not the
    // staff member who dispatched, and has no session anywhere.
    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()

    await vendorPage.goto(`/vendor/${token}`)
    await expect(vendorPage.getByRole('heading', { name: /Replace the kitchen tap/ })).toBeVisible()
    await expect(vendorPage.getByText('11 Vendor Way', { exact: false })).toBeVisible()
    await expect(vendorPage.getByText(tenantPhone!)).toBeVisible()
    await expect(vendorPage.getByText('Kitchen tap drips constantly.')).toBeVisible()

    await vendorPage.getByRole('button', { name: 'Accept this job' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.vendorResponse,
        { timeout: 10_000 },
      )
      .toBe('ACCEPTED')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.vendor_responded', entityId: workOrder.id },
    })
    expect(entry.actorType).toBe('VENDOR')
    expect(entry.actorRef).toBe(vendor.id)

    // THE LINK STILL WORKS - D-16's whole point. A single-use link would be
    // dead here, and the invoice would never arrive.
    await vendorPage.goto(`/vendor/${token}`)
    await vendorPage
      .getByLabel('What is this?')
      .selectOption('INVOICE')
    await vendorPage.getByLabel('Photo or file').setInputFiles({
      name: 'napkin.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('a photo of a handwritten invoice'),
    })
    await vendorPage.getByLabel('Invoice total (only if this is the invoice)').fill('185.50')
    await vendorPage.getByRole('button', { name: 'Upload' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.invoiceCents,
        { timeout: 10_000 },
      )
      .toBe(18_550)

    const document = await prisma.document.findFirstOrThrow({
      where: { workOrderId: workOrder.id, type: 'INVOICE' },
    })
    documentIds.push(document.id)
    expect(document.vendorId).toBe(vendor.id)

    await vendorContext.close()
  })

  test('an invoice over the approval is BANKED, and sends the job back for approval', async ({
    page,
  }) => {
    // MAINT-04's ceiling where the bill actually arrives. Deliberately not a
    // refusal: turning the vendor away means the invoice gets phoned in and
    // re-keyed, which is what D-6 and D-19 both exist to prevent. Take the
    // document, take the number, and put the JOB in front of somebody who
    // can say yes.
    const { workOrder, vendor } = await seedJob()
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { approvedAmountCents: 60_000 },
    })
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/${token}`)
    await vendorPage.getByRole('button', { name: 'Accept this job' }).click()
    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.vendorResponse,
        { timeout: 10_000 },
      )
      .toBe('ACCEPTED')

    await vendorPage.goto(`/vendor/${token}`)
    await vendorPage.getByLabel('What is this?').selectOption('INVOICE')
    await vendorPage.getByLabel('Photo or file').setInputFiles({
      name: 'big-invoice.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('a photo of an expensive invoice'),
    })
    await vendorPage.getByLabel('Invoice total (only if this is the invoice)').fill('2400')
    await vendorPage.getByRole('button', { name: 'Upload' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('PENDING_APPROVAL')

    // The money landed, and so did the evidence.
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.invoiceCents).toBe(240_000)
    const document = await prisma.document.findFirstOrThrow({
      where: { workOrderId: workOrder.id, type: 'INVOICE' },
    })
    documentIds.push(document.id)
    expect(document.vendorId).toBe(vendor.id)

    // And it is in the one queue (D-9), not only in a status column.
    const task = await prisma.task.findFirstOrThrow({
      where: { subjectId: workOrder.id, type: 'workorder_approval' },
    })
    expect(task.title).toContain('Invoice over approval')

    // The vendor is told nothing about the ceiling - not their business, and
    // "needs approval" invites the chasing phone call this path avoids.
    await expect(vendorPage.getByText('Invoice received')).toBeVisible()
    await expect(vendorPage.getByText(/approval/i)).toHaveCount(0)

    await vendorContext.close()
  })

  test('reveals an access code only after accepting, and logs every reveal', async ({ page }) => {
    const { workOrder, vendor } = await seedJob({ withAccessCode: true })
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()

    // Before accepting there is no code on the page at all.
    await vendorPage.goto(`/vendor/${token}`)
    await expect(vendorPage.getByRole('button', { name: /^Show the .* code$/ })).toHaveCount(0)

    await vendorPage.getByRole('button', { name: 'Accept this job' }).click()
    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.vendorResponse,
        { timeout: 10_000 },
      )
      .toBe('ACCEPTED')

    await vendorPage.goto(`/vendor/${token}`)
    await vendorPage.getByRole('button', { name: /^Show the .* code$/ }).click()
    await expect(vendorPage.getByText('4821')).toBeVisible()

    const reveals = await prisma.auditLog.findMany({
      where: { action: 'accesscode.revealed', propertyId: workOrder.propertyId },
    })
    expect(reveals.length).toBe(1)
    expect(reveals[0]!.actorType).toBe('VENDOR')
    expect(reveals[0]!.actorRef).toBe(vendor.id)

    await vendorContext.close()
  })

  test('declines with a reason, which hands the job back to the office', async ({ page }) => {
    const { workOrder } = await seedJob()
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()

    await vendorPage.goto(`/vendor/${token}`)
    // `getByText`, not a role: since R-098 the three answers are native
    // `<details>` disclosures, and `<summary>` has no portable role mapping -
    // the other specs in this suite select the app's other summaries the same
    // way. Regex, not a literal: it renders a typographic apostrophe.
    await vendorPage.getByText(/^I can.t take this$/).click()
    await vendorPage
      .getByLabel('Why not? (so we send the right person next)')
      .fill('Booked through next week')
    await vendorPage.getByRole('button', { name: 'Decline this job' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.vendorResponse,
        { timeout: 10_000 },
      )
      .toBe('DECLINED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    // Handed back: unassigned, so it shows in the queue as needing somebody.
    expect(updated.vendorId).toBeNull()
    expect(updated.vendorDeclineReason).toBe('Booked through next week')

    await vendorContext.close()
  })
})

test.describe('the link refuses', () => {
  test('a forged token', async ({ page }) => {
    await page.goto('/vendor/not-a-real-token-at-all')
    await expect(page.getByRole('heading', { name: /isn.t working/ })).toBeVisible()
  })

  test('a REASSIGNED vendor whose link has not expired', async ({ page }) => {
    // The security case that matters most: the office cannot recall a text
    // message, so this comparison is the only thing between a replaced
    // vendor and a live gate code.
    const { workOrder } = await seedJob({ withAccessCode: true })
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    const other = await prisma.vendor.create({
      data: { name: `Replacement-${randomUUID().slice(0, 6)}`, trades: ['plumbing'] },
    })
    vendorIds.push(other.id)
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { vendorId: other.id },
    })

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/${token}`)
    await expect(vendorPage.getByText(/reassigned/i)).toBeVisible()
    await expect(vendorPage.getByRole('button', { name: /^Show the .* code$/ })).toHaveCount(0)
    await vendorContext.close()
  })

  test('a document from somebody else’s job', async ({ page, request }) => {
    const first = await seedJob()
    const second = await seedJob()
    const token = await dispatchAndCaptureToken(page, first.workOrder.id, first.workOrder.propertyId)

    // A document that belongs to the OTHER job entirely.
    const foreign = await prisma.document.create({
      data: {
        propertyId: second.workOrder.propertyId,
        unitId: second.workOrder.unitId,
        workOrderId: second.workOrder.id,
        type: 'COMPLETION_PHOTO',
        fileName: 'someone-elses.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 3,
        storageKey: `test/${randomUUID()}.jpg`,
      },
    })
    documentIds.push(foreign.id)

    const response = await request.get(`/vendor/${token}/documents/${foreign.id}`)
    // 404, not 403 - "not yours" and "does not exist" must be
    // indistinguishable, or the status code confirms a guessed id is real.
    expect(response.status()).toBe(404)
  })

  test('any document at all on a forged token', async ({ request }) => {
    const response = await request.get('/vendor/forged/documents/whatever')
    expect(response.status()).toBe(404)
  })
})

test.describe('accessibility', () => {
  test('the vendor job page has no detectable violations', async ({ page }) => {
    const { workOrder } = await seedJob({ withAccessCode: true })
    const token = await dispatchAndCaptureToken(page, workOrder.id, workOrder.propertyId)

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/${token}`)

    const results = await axeScan(vendorPage)
    expect(results.violations).toEqual([])
    await vendorContext.close()
  })
})
