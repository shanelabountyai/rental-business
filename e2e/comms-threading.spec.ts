import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { threadKey } from '@rental/core/comms'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniquePhone } from './fixtures.ts'

// The merged work-order timeline through the browser (COMM-06, R-032).
//
// The database-level proofs - that two concurrent jobs for one vendor get
// separate threads, that untagged messages stay off the timeline, that a
// message from job A never leaks onto job B - live in
// apps/web/lib/workorders/timeline.test.ts. What only a browser proves is
// here: a staff member can actually add a note, reply to the tenant and the
// vendor from the work order's own page, and a vendor can message back from
// their magic-link page with no account at all.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `comms-${unique}@example.test`,
      name: `Comms Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedJob() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Comms LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Comms House-${unique}`,
      addressLine1: '5 Timeline Terrace',
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
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Comms-${unique}`, phone: uniquePhone() },
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
  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      source: 'PORTAL',
      category: 'PLUMBING',
      description: 'The kitchen tap will not stop dripping.',
      priority: 'ROUTINE',
      status: 'CONVERTED',
    },
  })
  ticketIds.push(ticket.id)
  const vendor = await prisma.vendor.create({
    data: { name: `Comms Plumbing-${unique}`, trades: ['plumbing'] },
  })
  vendorIds.push(vendor.id)
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      vendorId: vendor.id,
      scope: 'Replace the cartridge',
      status: 'ASSIGNED',
    },
  })
  workOrderIds.push(workOrder.id)

  return { property, unit, tenant, ticket, vendor, workOrder }
}

/// A vendor magic link, minted directly against the same AuthToken shape
/// `issueVendorLink()` writes (packages/core/auth's own mint, subjectType
/// WorkOrder, vendorId in metadata) - this spec is about the messaging
/// surface, not the dispatch flow itself (that is R-025's own coverage), so
/// there is no need to drive the "send the vendor their link" button first.
/// A relative import into app-internal code is deliberately avoided here -
/// no other e2e spec reaches into apps/web/lib, and `server-only`-guarded
/// modules are not guaranteed to load outside Next's own build.
async function mintVendorToken(workOrderId: string, vendorId: string) {
  const minted = mintToken('VENDOR_WORK_ORDER')
  await prisma.authToken.create({
    data: {
      purpose: 'VENDOR_WORK_ORDER',
      tokenHash: minted.tokenHash,
      subjectType: 'WorkOrder',
      subjectId: workOrderId,
      expiresAt: minted.expiresAt,
      metadata: { vendorId },
    },
  })
  return minted.token
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
  // Message and WorkOrderNote (append-only in practice - see the note
  // model's own comment; Message is trigger-enforced) stay, same as
  // AuditLog. Only the roots without an append-only chain pointing at them
  // get cleaned up, and even those are deactivated rather than deleted -
  // Message.ticketId/workOrderId are RESTRICT, so the Ticket and WorkOrder
  // rows this suite tagged messages onto cannot be deleted at all.
  await prisma.authToken.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.vendor.updateMany({
    where: { id: { in: vendorIds } },
    data: { active: false },
  })
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

test.describe('the work order timeline', () => {
  test('shows the original report, and an internal note never leaves the building', async ({
    page,
  }) => {
    const { workOrder } = await seedJob()
    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    const timeline = page.getByLabel('Timeline')
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
    await expect(
      timeline.getByText('The kitchen tap will not stop dripping.'),
    ).toBeVisible()

    await page.getByRole('heading', { name: 'Add an internal note' }).scrollIntoViewIfNeeded()
    await page
      .locator('form', { has: page.getByRole('button', { name: 'Add note' }) })
      .getByRole('textbox')
      .fill('Called the tenant, nobody home - trying again at 4pm.')
    await page.getByRole('button', { name: 'Add note' }).click()

    await expect(
      timeline.getByText('Called the tenant, nobody home - trying again at 4pm.'),
    ).toBeVisible()
    // The interpunct disambiguates from the form's own "Add an internal
    // note" heading and sr-only label, which also match a bare substring.
    await expect(timeline.getByText('Internal note ·')).toBeVisible()

    const note = await prisma.workOrderNote.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(note.body).toContain('nobody home')
    // Never a Message row - an internal note has no delivery, no recipient,
    // and must never be reachable by anything that could transmit it.
    expect(
      await prisma.message.count({ where: { workOrderId: workOrder.id } }),
    ).toBe(0)
  })

  test('a staff reply to the tenant lands on the timeline, tagged to this job', async ({
    page,
  }) => {
    const { workOrder, ticket, tenant } = await seedJob()
    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    await page.getByRole('heading', { name: 'Message the tenant' }).scrollIntoViewIfNeeded()
    const tenantForm = page.locator('form', { has: page.getByLabel('Send by') })
    await tenantForm.getByLabel('Reply').fill('We will be there Thursday morning.')
    await tenantForm.getByLabel('Send by').selectOption('PORTAL')
    await tenantForm.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText('We will be there Thursday morning.')).toBeVisible()

    const message = await prisma.message.findFirstOrThrow({
      where: { workOrderId: workOrder.id, direction: 'OUTBOUND' },
    })
    expect(message.ticketId).toBe(ticket.id)
    expect(message.tenantId ?? tenant.id).toBe(tenant.id)
  })

  test('a vendor message posted from the magic-link page reaches the staff timeline', async ({
    page,
  }) => {
    const { workOrder, vendor } = await seedJob()
    const token = await mintVendorToken(workOrder.id, vendor.id)

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/${token}`)

    await expect(vendorPage.getByRole('heading', { name: 'Messages' })).toBeVisible()
    await vendorPage.getByRole('textbox').last().fill('Running about 20 minutes late.')
    await vendorPage.getByRole('button', { name: 'Send this message' }).click()
    await expect(vendorPage.getByText('Running about 20 minutes late.')).toBeVisible()
    await expect(
      vendorPage.getByLabel('Messages').getByText('You', { exact: true }),
    ).toBeVisible()

    // R-140's demo walk found every message here stamped "2026-08-30 19:00" -
    // `utcToWallClock(...).replace('T', ' ')`, a machine format shown to a
    // stranger, and a third face of D-153's raw-date class that both R-128's
    // and R-129's greps missed. Asserted as the ABSENCE of the raw shape
    // rather than as an exact string: the wording may change, a raw date
    // reaching a vendor may not.
    expect(await vendorPage.locator('body').innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/)

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    const timeline = page.getByLabel('Timeline')
    await expect(timeline.getByText('Running about 20 minutes late.')).toBeVisible()

    const message = await prisma.message.findFirstOrThrow({
      where: { workOrderId: workOrder.id, vendorId: vendor.id },
    })
    expect(message.direction).toBe('INBOUND')
    expect(message.channel).toBe('PORTAL')

    // Closed, like every other spec that opens one. A context left open
    // survives the test and holds a live page against the shared browser
    // for the rest of the run - which is both a resource leak across ~500
    // tests and, seen once in a full run, a snapshot of somebody else's
    // page attributed to an unrelated failing test.
    await vendorContext.close()
  })

  test('staff can attach a stray tenant text that arrived before anyone tagged it', async ({
    page,
  }) => {
    const { workOrder, property, tenant } = await seedJob()
    // Unique per run: a fixed body string would be ambiguous the moment
    // another worker's copy of this same spec runs concurrently and seeds
    // an identical message - the DB-side lookup below has no other way to
    // tell the two apart.
    const body = `Still dripping, worse than before - ${randomUUID().slice(0, 8)}.`

    // An ordinary inbound text, exactly the shape SMS-intake writes -
    // untagged, because nothing at receive time knew which job it was
    // about. Built directly against the same deterministic key
    // `resolveThread()` computes (packages/core/comms), rather than
    // reaching into apps/web/lib from an e2e spec.
    const thread = await prisma.thread.upsert({
      where: {
        key: threadKey({ scope: 'TENANT', propertyId: property.id, tenantId: tenant.id }),
      },
      update: {},
      create: {
        key: threadKey({ scope: 'TENANT', propertyId: property.id, tenantId: tenant.id }),
        propertyId: property.id,
        tenantId: tenant.id,
      },
    })
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body,
        sentAt: new Date(),
        tenantId: tenant.id,
      },
    })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    await expect(
      page.getByText(/Recent messages that might belong here/),
    ).toBeVisible()
    await page.getByText(/Recent messages that might belong here/).click()
    await expect(page.getByText(body)).toBeVisible()
    await page.getByRole('button', { name: 'Attach' }).click()

    // Now on the timeline itself, not just the candidate list.
    await expect(page.getByLabel('Timeline').getByText(body)).toBeVisible()

    const message = await prisma.message.findFirstOrThrow({ where: { body } })
    // A link row, not a mutation to the message - Message is append-only,
    // so the row itself stays untouched (see WorkOrderMessageLink's own
    // schema comment).
    expect(message.workOrderId).toBeNull()

    // Polled, not a single read: the test's Prisma client is a separate
    // connection from the one the server action just committed through,
    // and against Neon's pooled connections a read immediately afterward
    // can occasionally land a beat before it is visible there - the same
    // gap properties.spec.ts's own comment documents.
    await expect
      .poll(() =>
        prisma.workOrderMessageLink.count({ where: { messageId: message.id } }),
      )
      .toBe(1)
    const link = await prisma.workOrderMessageLink.findUniqueOrThrow({
      where: { messageId: message.id },
    })
    expect(link.workOrderId).toBe(workOrder.id)
  })

  test('downloads a plain-text transcript', async ({ page }) => {
    const { workOrder } = await seedJob()
    const staff = await createStaff()
    await signIn(page, staff.email)

    const response = await page.request.get(`/workorders/${workOrder.id}/timeline`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/plain')
    const body = await response.text()
    expect(body).toContain('The kitchen tap will not stop dripping.')
    expect(body).toContain('not a formatted legal document')
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the timeline section and the vendor message thread have no violations', async ({
    page,
  }) => {
    const { workOrder, vendor } = await seedJob()

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    let results = await axeScan(page)
    expect(results.violations, 'work order timeline').toEqual([])

    const token = await mintVendorToken(workOrder.id, vendor.id)
    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/${token}`)
    results = await axeScan(vendorPage)
    expect(results.violations, 'vendor message thread').toEqual([])

    await vendorContext.close()
  })
})
