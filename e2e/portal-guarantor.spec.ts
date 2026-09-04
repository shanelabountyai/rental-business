import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// The guarantor portal (R-165, LEASE-06, ROLE-01).
//
// ==========================================================================
// THE POINT OF THIS FILE IS THE SCOPE, NOT THE SCREEN.
//
// LEASE-06 says a guarantor is "financially liable on the ledger, no portal
// access to maintenance or comms". That is two separate claims and both are
// tested here: they see their own lease's balance and notices (the grant),
// and they cannot reach another lease's notice, the tenant portal, or a
// document that is not a NOTICE on their own lease (the refusal). A rendering
// bug in the balance page would be caught by a snapshot; a scoping bug would
// not be caught by anything except a real cross-lease request, which is what
// every test below actually makes.
// ==========================================================================

const TENANT_PASSWORD = 'correct-horse-battery-staple'

const propertyIds: string[] = []
const entityIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []
const guarantorIds: string[] = []

async function seedGuaranteedLease() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Guarantor LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Guarantor House-${stamp}`,
      addressLine1: '9 Cosigner Court',
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
    data: {
      firstName: `Tenant${stamp}`,
      lastName: `Cosign-${stamp}`,
      email: `tenant-${stamp}@example.test`,
      phone: uniquePhone(),
      credential: { create: { passwordHash: await hashPassword(TENANT_PASSWORD) } },
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
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const guarantor = await prisma.guarantor.create({
    data: {
      leaseId: lease.id,
      firstName: `Pat${stamp}`,
      lastName: `Guarantee-${stamp}`,
      email: `guarantor-${stamp}@example.test`,
    },
  })
  guarantorIds.push(guarantor.id)

  return { entity, property, unit, tenant, lease, guarantor, stamp }
}

/// Mints a magic link the way the sign-in action would, without needing
/// email. Mirrors e2e/portal.spec.ts's TENANT_MAGIC_LINK helper.
async function guarantorMagicLinkFor(guarantorId: string) {
  const minted = mintToken('GUARANTOR_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'GUARANTOR_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Guarantor',
      subjectId: guarantorId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/guarantor/verify?token=${minted.token}`
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // Same wall every suite touching an append-only table hits: Notice,
  // NoticeDelivery and LedgerEntry all RESTRICT, so only the roots are
  // deactivated.
  await prisma.authToken.deleteMany({ where: { subjectId: { in: guarantorIds } } })
  await prisma.guarantor.updateMany({
    where: { id: { in: guarantorIds } },
    data: { active: false },
  })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('a guarantor sees their own lease and nobody else’s', () => {
  test('signs in and sees the balance for the lease they guarantee', async ({ page }) => {
    const { lease, property, guarantor } = await seedGuaranteedLease()
    await prisma.ledgerEntry.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'September rent',
        occurredAt: new Date('2026-09-01T00:00:00Z'),
      },
    })

    await page.goto(await guarantorMagicLinkFor(guarantor.id))
    await expect(page).toHaveURL(/\/portal\/guarantor$/)
    await expect(page.getByRole('heading', { name: 'What you guarantee' })).toBeVisible()
    // Scoped to the balance card, not a bare getByText: with one line on the
    // ledger, $1,500.00 also appears in the "Amount" and "Owed after"
    // columns below - the exact ambiguous-locator trap CLAUDE.md's own
    // route-announcer section warns about, just with a table instead of a
    // second heading.
    await expect(
      page.locator('section[aria-labelledby="now"]').getByText('$1,500.00'),
    ).toBeVisible()
    await expect(page.getByText('September rent')).toBeVisible()
  })

  test('cannot open a notice on a lease they do not guarantee', async ({ browser }) => {
    const mine = await seedGuaranteedLease()
    const theirs = await seedGuaranteedLease()
    const theirNotice = await prisma.notice.create({
      data: {
        propertyId: theirs.property.id,
        leaseId: theirs.lease.id,
        type: 'NOTICE_TO_VACATE',
        addressOfRecord: '9 Cosigner Court',
        bodyText: 'You must vacate the premises.',
      },
    })
    await prisma.noticeDelivery.create({
      data: { noticeId: theirNotice.id, method: 'PORTAL', servedAt: new Date() },
    })
    await prisma.notice.update({
      where: { id: theirNotice.id },
      data: { serviceMethod: 'PORTAL', servedAt: new Date() },
    })

    const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
    try {
      const page = await context.newPage()
      await page.goto(await guarantorMagicLinkFor(mine.guarantor.id))

      // 404, not 403 (ROLE-01): a status that distinguished "forbidden" from
      // "does not exist" would confirm a guessed id belongs to somebody.
      const response = await page.request.get(`/portal/guarantor/notices/${theirNotice.id}`)
      expect(response.status()).toBe(404)

      // No read receipt was written for a notice this guarantor never opened.
      const delivery = await prisma.noticeDelivery.findFirstOrThrow({
        where: { noticeId: theirNotice.id, method: 'PORTAL' },
      })
      expect(delivery.readAt).toBeNull()
    } finally {
      await context.close()
    }
  })

  test('opens their own served notice, and the read receipt lands', async ({ page }) => {
    const { lease, property, guarantor } = await seedGuaranteedLease()
    const notice = await prisma.notice.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'NOTICE_TO_VACATE',
        addressOfRecord: '9 Cosigner Court',
        bodyText: 'You must vacate the premises.',
      },
    })
    await prisma.noticeDelivery.create({
      data: { noticeId: notice.id, method: 'PORTAL', servedAt: new Date() },
    })
    await prisma.notice.update({
      where: { id: notice.id },
      data: { serviceMethod: 'PORTAL', servedAt: new Date() },
    })

    await page.goto(await guarantorMagicLinkFor(guarantor.id))
    await page.goto('/portal/guarantor/notices')
    await page.getByRole('link', { name: /About this lease/ }).click()
    await expect(page.getByText(/must vacate/)).toBeVisible()

    const delivery = await prisma.noticeDelivery.findFirstOrThrow({
      where: { noticeId: notice.id, method: 'PORTAL' },
    })
    expect(delivery.readAt).not.toBeNull()
  })

  test('a document that is not a NOTICE on their lease is refused', async ({ page }) => {
    const { lease, property, guarantor } = await seedGuaranteedLease()
    const executedLease = await prisma.document.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'LEASE',
        fileName: 'executed-lease.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5,
        storageKey: `guarantor-test/${randomUUID()}`,
      },
    })

    await page.goto(await guarantorMagicLinkFor(guarantor.id))
    const response = await page.request.get(`/api/documents/${executedLease.id}/file`)
    expect(response.status()).toBe(404)
  })

  test('is refused by the tenant portal, and a tenant session is refused here', async ({
    browser,
  }) => {
    const { guarantor, tenant } = await seedGuaranteedLease()

    const guarantorContext = await browser.newContext({
      extraHTTPHeaders: uniqueClientHeaders(),
    })
    try {
      const page = await guarantorContext.newPage()
      await page.goto(await guarantorMagicLinkFor(guarantor.id))
      // A guarantor session has no tenantId to scope by - requireTenant
      // refuses rather than upgrading it (same rule requireGuarantor takes
      // the other direction).
      await page.goto('/portal')
      await expect(page).toHaveURL(/\/portal\/login/)
    } finally {
      await guarantorContext.close()
    }

    const tenantContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
    try {
      const page = await tenantContext.newPage()
      const minted = mintToken('TENANT_MAGIC_LINK')
      await prisma.authToken.create({
        data: {
          purpose: 'TENANT_MAGIC_LINK',
          tokenHash: minted.tokenHash,
          subjectType: 'Tenant',
          subjectId: tenant.id,
          expiresAt: minted.expiresAt,
        },
      })
      await page.goto(`/portal/verify?token=${minted.token}`)
      await page.goto('/portal/guarantor')
      await expect(page).toHaveURL(/\/portal\/guarantor\/login/)
    } finally {
      await tenantContext.close()
    }
  })

  test('sends an anonymous visitor to sign in', async ({ page }) => {
    for (const url of ['/portal/guarantor', '/portal/guarantor/notices']) {
      await page.goto(url)
      await expect(page, url).toHaveURL(/\/portal\/guarantor\/login/)
    }
  })
})
