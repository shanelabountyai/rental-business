import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// The questions a texted-in request never got asked (MAINT-01, MAINT-02,
// R-177).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES HERE.
//
// The token's decision table and every write rule are unit-tested against the
// database in lib/maintenance/clarify-link.test.ts. What that cannot show is
// the two things the item actually turns on. First, that this page is
// reachable WITH NO SESSION and reaches nothing else — the tenant it exists
// for has a phone and no email, and portal login is email-only, so a page
// that quietly needed a session would be the same dead end R-032c already
// removed once. Second, that the seven troubleshooting scripts really do
// render here: they are chosen by an `appliesWhen` predicate over answers
// given three steps earlier, and "the script appeared" is not a claim a unit
// test on the write path can make.
// ==========================================================================

/**
 * Mints a clarify link the way `issueClarifyLink` does.
 *
 * NOT by importing it: that module is `server-only`, which cannot be loaded
 * into Playwright's plain-Node context — the same reason `pay-link.spec.ts`
 * mirrors its own minter. The shape is copied deliberately, revoke-then-create
 * included, so drift shows up as a failing test here rather than as a link
 * that works only in tests.
 */
async function mintClarifyLink(ticketId: string, tenantId: string) {
  const minted = mintToken('TICKET_CLARIFY')
  await prisma.authToken.updateMany({
    where: { purpose: 'TICKET_CLARIFY', subjectId: ticketId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  await prisma.authToken.create({
    data: {
      purpose: 'TICKET_CLARIFY',
      tokenHash: minted.tokenHash,
      subjectType: 'Ticket',
      subjectId: ticketId,
      expiresAt: minted.expiresAt,
      metadata: { tenantId },
    },
  })
  return minted.token
}

const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

/// A property, a tenancy and a ticket exactly as `handleInboundSms` leaves
/// one: the tenant's own words, no category, and both booleans defaulted to
/// false because nobody was ever asked.
async function seedTextedRequest(text = 'half the kitchen has no power') {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Clarify LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Clarify House-${stamp}`,
      addressLine1: '11 Text Street',
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
    // NO EMAIL, deliberately: this is R-021's persona and the reason the page
    // cannot be behind the portal's email-only login.
    data: {
      firstName: 'Dana',
      lastName: `Texter-${stamp}`,
      email: null,
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
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      source: 'SMS',
      category: 'UNCATEGORIZED',
      description: `${text}\n\nSent by text message. The tenant has not answered any clarifying questions, and may not use the portal — reply by text.`,
      priority: 'ROUTINE',
      status: 'NEW',
    },
  })
  return { property, unit, tenant, lease, ticket }
}

test.beforeEach(async ({ page }) => {
  // R-003 limits sign-in to ten attempts per IP per five minutes, and local
  // e2e traffic carries no x-forwarded-for. This spec never signs in, but a
  // shared bucket is the kind of thing a later test in this file inherits.
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // Scoped by propertyId (ownership), never by a collected-id list: a failing
  // assertion orphans everything created after it, and Document/Ticket rows
  // the APP created were never on any list here anyway.
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.workOrder.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.ticket.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  // Retired, not deleted: AuditLog is append-only by trigger and holds a
  // `ticket.clarified` entry naming these rows.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
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

test.describe('the clarify link', () => {
  test('walks a texted-in request through the same script the portal runs, with no session', async ({
    page,
  }) => {
    const { ticket, property } = await seedTextedRequest()
    const token = await mintClarifyLink(ticket.id, ticket.tenantId!)

    await page.goto(`/clarify/${token}`)

    // Their own words, read back — and NOT the staff-facing tail of the
    // description, which is internal operating vocabulary (D-10).
    await expect(page.getByText('half the kitchen has no power')).toBeVisible()
    await expect(page.getByText('may not use the portal')).toHaveCount(0)

    await page.getByRole('radio', { name: 'Electrical' }).check()
    await page.getByRole('button', { name: 'Next' }).click()

    await page.getByRole('radio', { name: 'Multiple outlets or lights' }).check()
    await page.getByRole('radio', { name: 'One room' }).check()
    await page.getByRole('button', { name: 'Next' }).click()

    // THE POINT OF THE ITEM. Until R-177 these seven scripts were reachable
    // only from the portal wizard — the channel the fewest tenants use — and
    // this tenant has no email to sign in with at all.
    await expect(
      page.getByRole('group', { name: 'Check for a GFCI reset button' }),
    ).toContainText('may be in another room')
    await page
      .getByRole('group', { name: 'Check the breaker panel' })
      .getByRole('radio', { name: 'I tried this' })
      .check()
    await page
      .getByRole('group', { name: 'Check for a GFCI reset button' })
      .getByRole('radio', { name: 'Skip this' })
      .check()
    await page.getByRole('button', { name: 'Next' }).click()

    // Photos step — optional, skipped.
    await page.getByRole('button', { name: 'Next' }).click()

    await page.getByRole('radio', { name: 'Yes, you can enter if I am not home' }).check()
    await page.getByRole('button', { name: 'Next' }).click()

    await page.getByRole('radio', { name: 'No', exact: true }).check()
    await page.getByRole('button', { name: 'Review' }).click()

    await page.getByRole('button', { name: 'Send answers' }).click()
    await expect(page.getByRole('heading', { name: 'Thanks' })).toBeVisible()

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.category).toBe('ELECTRICAL')
    // The SMS path could only default this to false, which is
    // indistinguishable from a tenant who said "come when I am home".
    expect(after.entryPermission).toBe(true)
    expect(after.description.startsWith('half the kitchen has no power')).toBe(true)
    expect(after.description).toContain(
      'Check the breaker panel: Tried this - did not fix it.',
    )

    // Attributed to the tenant by name, from a page with no session at all.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Ticket', entityId: ticket.id, action: 'ticket.clarified' },
    })
    expect(entry.actorType).toBe('TENANT')
    expect(property.id).toBe(after.propertyId)
  })

  test('the token opens this page and NOTHING else', async ({ browser }) => {
    // The claim D-45 turns on, asserted directly: a token-scoped page is
    // fail-closed because there is no session for another route to trust. An
    // implementation that quietly signed the tenant in would pass every unit
    // test and fail exactly this.
    const { ticket } = await seedTextedRequest('no hot water')
    const token = await mintClarifyLink(ticket.id, ticket.tenantId!)

    // A NEW CONTEXT DOES NOT INHERIT page.setExtraHTTPHeaders, so it needs
    // its own client IP or it shares a rate-limit bucket with every other
    // spec that forgot.
    const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
    try {
      const fresh = await context.newPage()
      await fresh.goto(`/clarify/${token}`)
      await expect(
        fresh.getByRole('heading', { name: 'A few questions about your request' }),
      ).toBeVisible()

      for (const path of ['/portal', '/portal/messages', '/portal/papers']) {
        await fresh.goto(path)
        await expect(fresh).toHaveURL(/\/portal\/login/)
      }
    } finally {
      await context.close()
    }
  })

  test('says so, kindly, once somebody is already on the way', async ({ page }) => {
    // Past this point the description is the sheet a vendor is working from.
    // A dead end that says only "invalid link" sends somebody to the phone,
    // which is the outcome this item exists to remove.
    const { ticket, property, unit } = await seedTextedRequest('bedroom window stuck')
    const token = await mintClarifyLink(ticket.id, ticket.tenantId!)
    await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        ticketId: ticket.id,
        scope: 'Free the sash',
      },
    })

    await page.goto(`/clarify/${token}`)
    await expect(page.getByText('We are already on this one')).toBeVisible()
  })
})
