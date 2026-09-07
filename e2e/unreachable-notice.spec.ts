import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'

// R-173: THE TENANT WITH NO EMAIL AND NO PHONE.
//
// The engine half is covered by unit tests (apps/web/lib/notifications/
// opt-out.test.ts): a locked-category notification to a recipient we hold no
// address for suppresses every channel - PORTAL included, because a portal
// entered only by a mailed magic link is not an address - and raises a
// `serve_notice_offline` task. This is the other half: the queue that task
// lands in, and the paper somebody actually carries to the door.
//
// The rows are seeded rather than produced by calling `notify()`. That module
// is `server-only` and lives behind the app's own path aliases; what needs
// proving out here is the READING - queue, task, printable - and seeding the
// engine's exact output shape is what makes this a test of the screens rather
// than a second test of the engine.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const taskIds: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  // Everything else is retired rather than deleted: the seeded Notification
  // rows are append-only and their property FK is ON DELETE SET NULL, which
  // is an UPDATE the trigger refuses. An inactive property is also this
  // suite's own marker for "this spec has finished" (R-109).
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedOwner() {
  const email = `unreachable-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Unreachable Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })
  return staff
}

/// One undeliverable entry notice, in the exact shape `notify()` leaves
/// behind: one Notification per channel under `<key>:<CHANNEL>`, every
/// delivery SUPPRESSED / no_address, and the task pointing at the base key.
async function seedUndeliverableNotice() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Unreachable LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Unreachable House-${randomUUID().slice(0, 8)}`,
      addressLine1: '9 No Signal Road',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const tenant = await prisma.tenant.create({
    // Neither column set. That is the whole premise, and both are nullable.
    data: { firstName: 'Nomail', lastName: `Nophone-${randomUUID().slice(0, 6)}` },
  })
  tenantIds.push(tenant.id)

  const key = `entry-notice:${randomUUID()}`
  for (const channel of ['EMAIL', 'SMS', 'PORTAL'] as const) {
    await prisma.notification.create({
      data: {
        idempotencyKey: `${key}:${channel}`,
        category: 'entry_notice',
        channel,
        recipientType: 'TENANT',
        recipientId: tenant.id,
        toAddress: '(none on file)',
        templateKey: 'entry.notice',
        subject: 'Notice of entry',
        body: 'We need to enter your home on 20 August 2026 between 3pm and 5pm.\n\nThe reason is the annual inspection. You do not need to be home.',
        propertyId: property.id,
        delivery: {
          create: { status: 'SUPPRESSED', suppressedReason: 'no_address' },
        },
      },
    })
  }

  const task = await prisma.task.create({
    data: {
      propertyId: property.id,
      type: 'serve_notice_offline',
      subjectType: 'Notification',
      subjectId: key,
      businessDate: new Date('2026-08-18T00:00:00.000Z'),
      priority: 'URGENT',
      title: 'Print and post entry notice - we hold no email or phone for this tenant',
    },
  })
  taskIds.push(task.id)

  return { property, tenant, task }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('a notice nobody could be sent', () => {
  test('the send log points at the queue, and the queue lists it', async ({ page }) => {
    const { task } = await seedUndeliverableNotice()
    const staff = await seedOwner()
    await signIn(page, staff.email)

    await page.goto('/notifications')
    await page.getByRole('link', { name: 'Open the queue to print and post' }).click()

    await page.waitForURL('**/tasks?type=serve_notice_offline')
    await expect(
      page.getByRole('heading', { name: 'Cannot be reached electronically' }),
    ).toBeVisible()
    // BY HREF, not by title. Every task this spec seeds carries the same
    // title - that is the point of it, the engine writes one sentence for the
    // case - so two of them on one queue is an ambiguous locator the moment a
    // sibling test's fixture lands in the same shared database. The id is the
    // only thing unique to this row.
    await expect(page.locator(`a[href="/tasks/${task.id}"]`)).toContainText(
      'Print and post entry notice',
    )
  })

  test('the task hands over a printable PDF of the notice itself', async ({ page }) => {
    const { task } = await seedUndeliverableNotice()
    const staff = await seedOwner()
    await signIn(page, staff.email)

    await page.goto(`/tasks/${task.id}`)
    const link = page.getByRole('link', {
      name: 'Print this notice to post on the door (PDF)',
    })
    await expect(link).toBeVisible()

    // Fetched rather than clicked: the link opens a PDF in a new tab, and
    // what matters is the bytes and the headers, not a browser's viewer.
    const response = await page.request.get(`/tasks/${task.id}/printable`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('application/pdf')
    const body = await response.body()
    expect(body.subarray(0, 4).toString()).toBe('%PDF')
  })

  test('a printable outside your scope is 404, not 403', async ({ page }) => {
    // ROLE-01: "not yours" and "does not exist" have to be indistinguishable,
    // or the status confirms that a guessed task id belongs to somebody.
    const { task } = await seedUndeliverableNotice()
    const { property: mine } = await seedUndeliverableNotice()
    const email = `scoped-${randomUUID()}@example.test`
    const staff = await prisma.staffUser.create({
      data: {
        email,
        name: 'Scoped Test',
        credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
      },
    })
    staffIds.push(staff.id)
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
    await prisma.staffAssignment.create({
      data: { staffUserId: staff.id, roleId: role.id, propertyId: mine.id },
    })

    await signIn(page, staff.email)
    const response = await page.request.get(`/tasks/${task.id}/printable`)
    expect(response.status()).toBe(404)
  })
})
