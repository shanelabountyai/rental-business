import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// The tenant maintenance request flow (MAINT-01, R-019): category → 2-3
// clarifying prompts → troubleshooting script (logging tried/declined) →
// photos → entry permission → pet warning → submit.
//
// The troubleshooting gate and cross-tenant scoping are the two things worth
// protecting here: MAINT-01 says logging tried/declined is required "before
// dispatch is allowed", and a tenant's maintenance history is their own
// record under the same DOC-03-style rule R-018 already established for
// papers and messages.

const propertyIds: string[] = []
const entityIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []

async function seedTenancy(label: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `Maint LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Maint House-${randomUUID().slice(0, 8)}`,
      addressLine1: '77 Willow Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const tenant = await prisma.tenant.create({
    data: {
      firstName: label,
      lastName: `Ortiz-${randomUUID().slice(0, 6)}`,
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
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })

  return { property, tenant, unit }
}

/// Mirrors e2e/auth.spec.ts's identical helper.
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

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { ticketId: { in: ticketIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
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

test.describe('submitting a request', () => {
  test('walks the flow end to end and creates a real ticket', async ({ page }) => {
    const { tenant } = await seedTenancy('Priya')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')
    await page.waitForTimeout(500)

    await page.getByRole('radio', { name: 'Locks & doors' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: "Won't lock" }).check()
    await page.getByRole('radio', { name: 'Front door' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // LOCKS has no troubleshooting script, so the wizard skips straight to
    // photos - proving "when applicable" actually skips when it does not.
    await expect(page.getByText('Add a photo (optional)')).toBeVisible()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: 'Yes, you can enter if I am not home' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: 'No', exact: true }).check()
    await page.getByRole('button', { name: 'Review' }).click()

    await expect(page.getByText('Locks & doors')).toBeVisible()
    await page.getByRole('button', { name: 'Send request' }).click()

    await page.waitForURL(/\/portal\/maintenance\/[a-z0-9]+$/)
    await expect(page.getByRole('heading', { name: 'Locks & doors' })).toBeVisible()
    await expect(page.getByText('Just sent')).toBeVisible()

    const ticket = await prisma.ticket.findFirstOrThrow({
      where: { tenantId: tenant.id },
    })
    ticketIds.push(ticket.id)
    expect(ticket.source).toBe('PORTAL')
    expect(ticket.category).toBe('LOCKS')
    expect(ticket.entryPermission).toBe(true)
    expect(ticket.petWarning).toBe(false)
    expect(ticket.description).toContain("Won't lock")

    // MAINT-01: audit the submission itself, verbatim, since Ticket keeps
    // getting edited by triage afterward.
    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'Ticket', entityId: ticket.id, action: 'ticket.submitted' },
    })
    expect(entry).not.toBeNull()
  })

  test('walks the whole flow with NO JavaScript and creates a real ticket', async ({
    browser,
  }) => {
    // THE REASON THIS WIZARD WAS REBUILT (R-112, audit angle ④). It was seven
    // `onClick` handlers over `useState`: before hydration - a cheap phone on
    // a weak connection - the radios rendered and were tappable and Next did
    // nothing at all, with no message. Disabling JavaScript outright is how a
    // test sees that window, exactly as `emergency.spec.ts` already does for
    // the flow next door.
    //
    // It walks the WHOLE flow rather than asserting one step renders,
    // because every step carries the earlier answers as hidden inputs and it
    // is the carrying that breaks first: an assertion on step two would pass
    // against a wizard that silently forgot the category by step five.
    const context = await browser.newContext({
      javaScriptEnabled: false,
      ...uniqueClientHeaders(),
    })
    const page = await context.newPage()
    const { tenant } = await seedTenancy('Nolan')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')

    await page.getByRole('radio', { name: 'Locks & doors' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: "Won't lock" }).check()
    await page.getByRole('radio', { name: 'Front door' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // LOCKS has no troubleshooting script, so this is also the no-JS proof
    // that the skip is computed from the answers rather than from a handler.
    await expect(page.getByText('Add a photo (optional)')).toBeVisible()
    // Asserted in the MARKUP, not as a visible node: `javaScriptEnabled:
    // false` stops scripts running but does not flip the parser's scripting
    // flag, so `<noscript>` stays the inert raw text the UA stylesheet hides.
    // A real browser with JavaScript turned off renders it.
    expect(await page.content()).toContain('Choosing photos needs JavaScript')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: 'Yes, you can enter if I am not home' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.getByRole('radio', { name: 'No', exact: true }).check()
    await page.getByRole('button', { name: 'Review' }).click()

    await expect(page.getByText('Locks & doors')).toBeVisible()
    await page.getByRole('button', { name: 'Send request' }).click()
    await page.waitForURL(/\/portal\/maintenance\/[a-z0-9]+$/)

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { tenantId: tenant.id } })
    ticketIds.push(ticket.id)
    expect(ticket.category).toBe('LOCKS')
    // The answers survived five navigations, which is the actual claim.
    expect(ticket.description).toContain("Won't lock")
    expect(ticket.description).toContain('Front door')
    expect(ticket.entryPermission).toBe(true)
    expect(ticket.petWarning).toBe(false)
    await context.close()
  })

  test('refuses a step the answers do not reach, rather than rendering nothing', async ({
    page,
  }) => {
    // A hand-typed or stale URL is now a real input (R-112). `reachableStep`
    // clamps it to the first step still missing something, and that step's
    // own "why you cannot continue" text is already on screen - derived from
    // the same answers, so it needs no round trip.
    const { tenant } = await seedTenancy('Ada')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new?step=review&category=LOCKS')

    await expect(page.getByText('A few questions about it')).toBeVisible()
    await expect(page.getByText('Answer every question above to continue.')).toBeVisible()
  })

  test('THE GATE: cannot proceed past troubleshooting without tried/declined on every step', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy('Devon')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')
    await page.waitForTimeout(500)

    await page.getByRole('radio', { name: 'Electrical' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'One outlet' }).check()
    await page.getByRole('radio', { name: 'One room' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // Electrical always shows breaker + GFCI. Answer only the first.
    await expect(page.getByText('Check the breaker panel')).toBeVisible()
    await page
      .locator('fieldset', { hasText: 'Check the breaker panel' })
      .getByRole('radio', { name: 'I tried this' })
      .check()

    const next = page.getByRole('button', { name: 'Next', exact: true })
    // `aria-disabled`, NOT `disabled` (R-101b). A disabled button leaves the
    // tab order entirely, so a keyboard user tabs straight past the only
    // thing between them and submitting, with nothing said about why. It
    // stays focusable and announces the reason instead.
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText('Tell us whether you tried each step')).toBeVisible()

    await page
      .locator('fieldset', { hasText: 'Check for a GFCI reset button' })
      .getByRole('radio', { name: 'Skip this' })
      .check()
    await expect(next).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('flags habitability language for triage, without showing it to the tenant', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy('Kim')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')
    await page.waitForTimeout(500)

    await page.getByRole('radio', { name: 'Appliance' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'Refrigerator' }).check()
    await page
      .getByLabel("What's happening? A sentence or two is fine.")
      .fill('There is mold growing inside near the seal.')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // Refrigerator has no troubleshooting script - straight to photos.
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'No, please schedule a time with me' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'No', exact: true }).check()
    await page.getByRole('button', { name: 'Review' }).click()
    await page.getByRole('button', { name: 'Send request' }).click()
    await page.waitForURL(/\/portal\/maintenance\/[a-z0-9]+$/)

    // expect.poll(), not a direct read: this test's own Prisma connection is
    // separate from the server's, and Neon's pooler does not guarantee it
    // observes a just-committed write immediately (R-008's documented lag).
    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { tenantId: tenant.id } })
    ticketIds.push(ticket.id)
    expect(ticket.habitabilityFlag).toBe(true)
    // Staff triage vocabulary, not shown on the tenant's own confirmation.
    await expect(page.getByText('habitability', { exact: false })).toHaveCount(0)
  })

  test('attaches a photo selected mid-flow to the finished ticket', async ({ page }) => {
    const { tenant } = await seedTenancy('Sam')
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')
    await page.waitForTimeout(500)

    await page.getByRole('radio', { name: 'Pests or bugs' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'Ants' }).check()
    await page.getByLabel('Where have you seen them?').fill('Kitchen counter')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await page.setInputFiles('input[type="file"]', {
      name: 'ants.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('fake-image-bytes'),
    })
    // Never blocks: the wizard is usable immediately, before the upload
    // necessarily finishes.
    await expect(page.getByText('ants.jpg')).toBeVisible()

    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'Yes, you can enter if I am not home' }).check()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('radio', { name: 'No', exact: true }).check()
    await page.getByRole('button', { name: 'Review' }).click()
    await expect(page.getByText('1 attached')).toBeVisible()
    await page.getByRole('button', { name: 'Send request' }).click()
    await page.waitForURL(/\/portal\/maintenance\/[a-z0-9]+$/)

    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { tenantId: tenant.id } })
    ticketIds.push(ticket.id)

    await expect
      .poll(
        async () =>
          prisma.document.count({
            where: { ticketId: ticket.id, type: 'MAINTENANCE_PHOTO' },
          }),
        { timeout: 10_000 },
      )
      .toBe(1)
    await expect(page.getByText('ants.jpg')).toBeVisible()
  })

  test('lets a tenant add a photo after submitting, as the upload-recovery path', async ({
    page,
  }) => {
    const { tenant, property, unit } = await seedTenancy('Nia')
    const ticket = await prisma.ticket.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category: 'HVAC',
        description: 'Test ticket for photo add-on.',
      },
    })
    ticketIds.push(ticket.id)

    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)
    await expect(page.getByText('No photos yet.')).toBeVisible()

    await page.waitForTimeout(500)
    await page.setInputFiles('input[type="file"]', {
      name: 'furnace.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('fake-image-bytes'),
    })

    await expect(page.getByRole('link', { name: 'furnace.jpg' })).toBeVisible()
    const attached = await prisma.document.findFirst({
      where: { ticketId: ticket.id, fileName: 'furnace.jpg' },
    })
    expect(attached).not.toBeNull()
  })
})

test.describe('scoping (DOC-03-style)', () => {
  test('never lists or shows another tenant’s request', async ({ page }) => {
    const mine = await seedTenancy('Owen')
    const theirs = await seedTenancy('Frankie')
    const theirTicket = await prisma.ticket.create({
      data: {
        propertyId: theirs.property.id,
        unitId: theirs.unit.id,
        tenantId: theirs.tenant.id,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'Not yours.',
      },
    })
    ticketIds.push(theirTicket.id)

    await page.goto(await magicLinkFor(mine.tenant.id))
    await page.goto('/portal/maintenance')
    await expect(page.getByText('Not yours.')).toHaveCount(0)

    const response = await page.goto(`/portal/maintenance/${theirTicket.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the maintenance list, wizard, and a ticket detail page have no detectable violations', async ({
    page,
  }) => {
    const { tenant, property, unit } = await seedTenancy('Ruth')
    const ticket = await prisma.ticket.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'Test ticket.',
      },
    })
    ticketIds.push(ticket.id)

    await page.goto(await magicLinkFor(tenant.id))

    for (const url of [
      '/portal/maintenance',
      '/portal/maintenance/new',
      `/portal/maintenance/${ticket.id}`,
    ]) {
      await page.goto(url)
      const results = await axeScan(page)
      expect(results.violations, url).toEqual([])
    }
  })
})
