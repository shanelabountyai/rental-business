import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The tenant portal shell (R-018, PRD §6.4, DOC-03, D-8, D-10).
//
// The cross-tenant tests are the point of this file. DOC-03 asks for "only
// mine - enforced server-side and verified by permission tests", and the
// failure it guards against is not a rendering bug: it is one tenant reading
// another's lease, at the same address, through a guessed URL.

const propertyIds: string[] = []
const entityIds: string[] = []
const tenantIds: string[] = []
const documentIds: string[] = []
const threadIds: string[] = []
const staffIds: string[] = []

async function seedTenancy(label: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `Portal LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Portal House-${randomUUID().slice(0, 8)}`,
      addressLine1: '42 Magnolia Drive',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
    },
  })
  propertyIds.push(property.id)

  const tenant = await prisma.tenant.create({
    data: {
      firstName: label,
      lastName: `Rivera-${randomUUID().slice(0, 6)}`,
      email: `${label.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
    },
  })
  tenantIds.push(tenant.id)

  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `U-${randomUUID().slice(0, 6)}`,
      status: 'OCCUPIED',
    },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      endsOn: new Date('2026-12-31'),
      rentCents: 185_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })

  return { property, tenant, lease }
}

async function seedDocument(args: {
  propertyId: string
  tenantId?: string
  leaseId?: string
  type?: string
  fileName: string
  sizeBytes?: number
}) {
  const document = await prisma.document.create({
    data: {
      propertyId: args.propertyId,
      tenantId: args.tenantId ?? null,
      leaseId: args.leaseId ?? null,
      type: args.type ?? 'LEASE',
      fileName: args.fileName,
      contentType: 'application/pdf',
      sizeBytes: args.sizeBytes ?? 100,
      storageKey: `portal-test/${randomUUID()}`,
    },
  })
  documentIds.push(document.id)
  return document
}

/// Mints a magic link the way the sign-in action would, without needing
/// email. Mirrors e2e/auth.spec.ts's identical helper.
async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

/**
 * Mirrors LocalDiskStorageAdapter's own path resolution (D-14).
 *
 * `apps/web`, not the repo root: the Next dev server runs with its own
 * package as the working directory, so `process.cwd()` inside the server and
 * inside this test are DIFFERENT directories. Writing to the test's cwd
 * produced a file the server could not find - a 500 that looked like an
 * authorization failure until both `.data` directories turned up on disk.
 */
async function writeStorageBytes(storageKey: string, contents: string) {
  const root = resolve(
    process.env.DOCUMENT_STORAGE_PATH ??
      join(process.cwd(), 'apps', 'web', '.data', 'documents'),
  )
  const path = resolve(root, storageKey)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(contents))
}

const STAFF_PASSWORD = 'correct-horse-battery-staple'

async function createOwnerStaff() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `portal-staff-${randomUUID()}@example.test`,
      name: 'Portal Staff Test',
      credential: {
        create: { passwordHash: await hashPassword(STAFF_PASSWORD) },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })
  return staff
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.authToken.deleteMany({
    where: { subjectId: { in: tenantIds } },
  })
  // Threads may carry append-only Messages, so properties and tenants are
  // deactivated rather than deleted - the same wall every other spec hits.
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  const audited = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !audited.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !audited.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...audited] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('the portal shell', () => {
  test('greets the tenant and shows their own home in plain words', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy('Dana')
    await page.goto(await magicLinkFor(tenant.id))
    await expect(page).toHaveURL(/\/portal$/)

    await expect(
      page.getByRole('heading', { name: 'Hello, Dana', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText('42 Magnolia Drive')).toBeVisible()
    // D-10's lexicon and §6.4's reading level: money said the way somebody
    // would say it, and no status enum on screen.
    await expect(page.getByText('$1,850.00 a month')).toBeVisible()
    await expect(page.getByText('Your lease is current.')).toBeVisible()
    await expect(page.getByText('ACTIVE')).toHaveCount(0)
  })

  test('offers a staff-mediated fallback rather than forcing the portal', async ({
    page,
  }) => {
    // §6.4: "every tenant flow has a staff-mediated fallback (P4 Gene is the
    // acid test)."
    const { tenant } = await seedTenancy('Gene')
    await page.goto(await magicLinkFor(tenant.id))
    await expect(
      page.getByText(/you do not have to use this site/i),
    ).toBeVisible()
  })

  test('sends an anonymous visitor to sign in, not to a broken shell', async ({
    page,
  }) => {
    for (const url of ['/portal', '/portal/papers', '/portal/messages']) {
      await page.goto(url)
      await expect(page).toHaveURL(/\/portal\/login/)
    }
  })

  test('never treats a staff session as a tenant', async ({ page }) => {
    // requireTenant refuses a non-tenant principal rather than upgrading it.
    // A STAFF session has no tenantId to scope by, so a code path that let one
    // through would be scoping against nothing - and "no scope" on a query
    // that filters by tenant is every tenant. An owner is used deliberately:
    // the most privileged staff principal there is must still get nothing here.
    const staff = await createOwnerStaff()
    await page.goto('/login')
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill(STAFF_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('**/dashboard')

    for (const url of ['/portal', '/portal/papers', '/portal/messages']) {
      await page.goto(url)
      await expect(page, url).toHaveURL(/\/portal\/login/)
    }
  })

  test('serves an installable PWA manifest scoped to the portal (D-8)', async ({
    page,
  }) => {
    const response = await page.request.get('/manifest.webmanifest')
    expect(response.ok()).toBe(true)
    const manifest = await response.json()
    // Scoped to /portal, not /: a tenant who installs this must land in their
    // portal, never on the staff sign-in.
    expect(manifest.scope).toBe('/portal')
    expect(manifest.start_url).toBe('/portal')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.length).toBeGreaterThan(0)
  })
})

test.describe('a tenant sees only their own papers (DOC-03)', () => {
  test('lists their lease and never the neighbour’s', async ({ page }) => {
    const mine = await seedTenancy('Ada')
    // Same property - a duplex. This is the leak that matters.
    const neighbourTenant = await prisma.tenant.create({
      data: { firstName: 'Neighbour', lastName: `N-${randomUUID().slice(0, 6)}` },
    })
    tenantIds.push(neighbourTenant.id)
    const neighbourUnit = await prisma.unit.create({
      data: {
        propertyId: mine.property.id,
        name: `U-${randomUUID().slice(0, 6)}`,
        status: 'OCCUPIED',
      },
    })
    const neighbourLease = await prisma.lease.create({
      data: {
        propertyId: mine.property.id,
        unitId: neighbourUnit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
      },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: neighbourLease.id, tenantId: neighbourTenant.id },
    })

    await seedDocument({
      propertyId: mine.property.id,
      leaseId: mine.lease.id,
      fileName: 'my-lease.pdf',
    })
    const theirs = await seedDocument({
      propertyId: mine.property.id,
      leaseId: neighbourLease.id,
      fileName: 'neighbour-lease.pdf',
    })
    const deed = await seedDocument({
      propertyId: mine.property.id,
      type: 'DEED',
      fileName: 'the-deed.pdf',
    })

    await page.goto(await magicLinkFor(mine.tenant.id))
    await page.goto('/portal/papers')

    await expect(page.getByText('my-lease.pdf')).toBeVisible()
    await expect(page.getByText('neighbour-lease.pdf')).toHaveCount(0)
    // The landlord's own file lives at the same property and must never leak.
    await expect(page.getByText('the-deed.pdf')).toHaveCount(0)

    // And not merely hidden in the markup - the bytes are refused too. A
    // guessed id is the realistic attack, and the list being right is not
    // enough on its own.
    for (const document of [theirs, deed]) {
      const response = await page.request.get(
        `/api/documents/${document.id}/file`,
      )
      // 404, not 403: "not yours" must be indistinguishable from "does not
      // exist", or the status confirms whose it is.
      expect(response.status()).toBe(404)
    }
  })

  test('serves the tenant their own document', async ({ page }) => {
    const mine = await seedTenancy('Bo')
    const doc = await seedDocument({
      propertyId: mine.property.id,
      tenantId: mine.tenant.id,
      fileName: 'my-notice.pdf',
      sizeBytes: 'hello'.length,
    })
    // Written straight to disk rather than through the storage adapter:
    // lib/storage is `server-only`, which throws outside a Next runtime. The
    // path scheme is LocalDiskStorageAdapter's (D-14) and DOCUMENT_STORAGE_PATH
    // is the same variable the server reads.
    await writeStorageBytes(doc.storageKey, 'hello')

    await page.goto(await magicLinkFor(mine.tenant.id))
    const response = await page.request.get(`/api/documents/${doc.id}/file`)
    expect(response.ok()).toBe(true)
    expect(await response.text()).toBe('hello')
  })
})

test.describe('messages', () => {
  test('shows their conversation and lets them reply', async ({ page }) => {
    const mine = await seedTenancy('Cleo')
    const thread = await prisma.thread.create({
      data: {
        key: `tenant:${mine.tenant.id}:property:${mine.property.id}`,
        propertyId: mine.property.id,
        tenantId: mine.tenant.id,
        lastMessageAt: new Date(),
      },
    })
    threadIds.push(thread.id)
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'OUTBOUND',
        body: 'The plumber is booked for Tuesday morning.',
        sentAt: new Date(),
      },
    })

    await page.goto(await magicLinkFor(mine.tenant.id))
    await page.goto('/portal/messages')
    await page.getByRole('link', { name: /Portal House/ }).click()

    await expect(
      page.getByText('The plumber is booked for Tuesday morning.'),
    ).toBeVisible()
    // Attribution in words, not by which side the bubble sits on (§6.4).
    await expect(page.getByText('From your landlord')).toBeVisible()

    await page.waitForTimeout(500)
    await page.getByLabel('Write a message').fill('Tuesday works, thank you.')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText('Tuesday works, thank you.')).toBeVisible()
    // Scoped to the reply's own row: bare 'From you' is a substring of
    // 'From your landlord', so it matches the landlord's message too.
    const myMessage = page
      .getByRole('listitem')
      .filter({ hasText: 'Tuesday works, thank you.' })
    await expect(myMessage.getByText(/^From you ·/)).toBeVisible()

    await expect
      .poll(
        async () =>
          prisma.message.count({
            where: { threadId: thread.id, direction: 'INBOUND' },
          }),
        { timeout: 10_000 },
      )
      .toBe(1)
  })

  test('refuses another tenant’s conversation', async ({ page }) => {
    const mine = await seedTenancy('Devi')
    const theirs = await seedTenancy('Eli')
    const theirThread = await prisma.thread.create({
      data: {
        key: `tenant:${theirs.tenant.id}:property:${theirs.property.id}`,
        propertyId: theirs.property.id,
        tenantId: theirs.tenant.id,
      },
    })
    threadIds.push(theirThread.id)

    await page.goto(await magicLinkFor(mine.tenant.id))
    const response = await page.goto(`/portal/messages/${theirThread.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('every portal screen has no detectable violations', async ({ page }) => {
    const mine = await seedTenancy('Faye')
    await seedDocument({
      propertyId: mine.property.id,
      leaseId: mine.lease.id,
      fileName: 'lease.pdf',
    })
    const thread = await prisma.thread.create({
      data: {
        key: `tenant:${mine.tenant.id}:property:${mine.property.id}`,
        propertyId: mine.property.id,
        tenantId: mine.tenant.id,
      },
    })
    threadIds.push(thread.id)

    await page.goto(await magicLinkFor(mine.tenant.id))

    // THE MONEY SCREENS WERE MISSING FROM THIS LIST, AND THAT IS WHY
    // MILESTONE 11'S WALK FOUND A SERIOUS VIOLATION ON `/portal/pay/history`
    // rather than the suite doing it. Paying rent is the tenant's primary job
    // (R-112's own words) and `/portal/pay/history` carries the widest table
    // in the portal - which is exactly the content that scrolls sideways on a
    // phone, and exactly the content with no link or button in it to focus.
    //
    // `scrollable-region-focusable` only fires when the region ACTUALLY
    // overflows, so this guard is worth having and is not worth trusting on
    // its own: a fixture with two short rows will not trip it at any width.
    // The fix it guards lives in `scrollableRegionProps`.
    for (const url of [
      '/portal',
      '/portal/pay',
      '/portal/pay/history',
      '/portal/papers',
      '/portal/messages',
      `/portal/messages/${thread.id}`,
    ]) {
      await page.goto(url)
      const results = await axeScan(page)
      expect(results.violations, url).toEqual([])
    }
  })

  test('keeps pinch-zoom working and text at 16px or larger', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy('Gus')
    await page.goto(await magicLinkFor(tenant.id))

    // Disabling zoom is the most common mobile accessibility failure and
    // fails WCAG 1.4.4 outright. Assert the meta tag never acquires it.
    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute('content')
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/i)
    expect(viewport).not.toMatch(/maximum-scale\s*=\s*1/i)

    // §6.4: 16px base minimum. The staff shell's default is 14px, so this is
    // a real difference rather than a restatement of the framework default.
    const bodySize = await page.evaluate(() => {
      const main = document.querySelector('main')
      return main ? Number.parseFloat(getComputedStyle(main).fontSize) : 0
    })
    expect(bodySize).toBeGreaterThanOrEqual(16)
  })

  test('offers a skip link before the navigation', async ({ page }) => {
    const { tenant } = await seedTenancy('Hana')
    await page.goto(await magicLinkFor(tenant.id))

    await page.keyboard.press('Tab')
    const focused = page.locator(':focus')
    await expect(focused).toHaveText(/skip to content/i)
  })
})
