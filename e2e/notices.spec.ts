import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// Notice delivery proof, end to end (COMM-02, R-051).
//
// ==========================================================================
// THE ONE THING THIS FILE EXISTS TO PROVE: A NOTICE IS SERVED MORE THAN ONCE,
// AND EACH SERVICE CARRIES ITS OWN PROOF.
//
// Texas requires a notice to vacate be delivered in person, by mail, or
// affixed to the door - and the careful operator does two of those. The
// single `Notice.serviceMethod` column this item replaced could record one.
// So: post it with a photograph, mail it with a tracking number, and assert
// both survive on the same notice with their own evidence attached.
//
// The database refuses a posted service with no photograph (a CHECK
// constraint, tested directly in apps/web/lib/notices/notices.test.ts). What
// is tested HERE is the half that only exists through a browser: that the
// form asks for the photograph, that the server refuses without it, and that
// the tenant opening the notice writes the read receipt.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'
const TENANT_PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

/// A 1x1 PNG. Small enough to inline, real enough that the upload path,
/// the content-type check and the EXIF reader all run for real.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function createStaff(roleKey: string, propertyId?: string) {
  const email = `notice-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Notice Test Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId },
  })
  return staff
}

async function seedNotice() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Notice LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Notice House-${stamp}`,
      addressLine1: '7 Notice Lane',
      city: 'Houston',
      // TEXAS, because R-010 seeds its service-method rules and R-051 filled
      // them in. A state with no rule would make every method "unverified"
      // and the permitted/not-permitted distinction untestable.
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
      firstName: `Nadia${stamp}`,
      lastName: `Notice-${stamp}`,
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

  const notice = await prisma.notice.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'NOTICE_TO_VACATE',
      addressOfRecord: '7 Notice Lane, Houston, TX 77002',
      bodyText: `You must vacate the premises.\n\nThe reason is non-payment of rent for ${stamp}.`,
    },
  })

  return { entity, property, unit, tenant, lease, notice, stamp }
}

/// A `datetime-local` value in the PROPERTY's timezone, N hours ago.
///
/// NOT a hardcoded date. The first draft of this file used a literal
/// '2026-08-16T09:30' and every service test failed with "cannot be recorded
/// in the future" - because the property is America/Chicago and the machine
/// had already rolled past UTC midnight, so the literal was genuinely
/// tomorrow. The same UTC-vs-property-local fencepost this product's own
/// date helpers exist to kill, committed in a fixture.
function localInputValue(hoursAgo: number, timeZone: string): string {
  const instant = new Date(Date.now() - hoursAgo * 3_600_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/// Mints a magic link the way the sign-in action would. The portal has no
/// password sign-in at all - it is magic-link only - which the first draft of
/// this file got wrong. Mirrors e2e/portal.spec.ts's identical helper.
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

async function signInStaff(page: import('@playwright/test').Page, email: string) {
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

test.describe('notice delivery proof (COMM-02)', () => {
  test('POSTED AND MAILED — one notice, two service events, each with its own proof', async ({
    page,
  }) => {
    const { property, notice } = await seedNotice()
    const staff = await createStaff('manager', property.id)
    await signInStaff(page, staff.email)

    await page.goto(`/notices/${notice.id}`)
    await expect(page.getByText('Not served yet')).toBeVisible()

    // ---- 1. Posted on the door, with a photograph ----
    await page.getByLabel('How was it served?').selectOption('POSTED_WITH_PHOTO')
    await page.getByLabel('When was it served?').fill(localInputValue(3, property.timezone))
    await page.getByLabel('Photo of the posted notice').setInputFiles({
      name: 'door.png',
      mimeType: 'image/png',
      buffer: PNG_1PX,
    })
    await page.getByRole('button', { name: 'Record service' }).click()
    // Waits on the SERVICE LIST, which is server-rendered from the database,
    // not on the "Service recorded." banner. The banner is a poor signal for
    // the second submit below: it is still on screen from this one, so the
    // assertion would pass instantly and the test would race the action it
    // is supposed to be waiting for. (It did, the first time this was run.)
    await expect(
      page.getByRole('link', { name: /Proof: door\.png/ }),
    ).toBeVisible()

    // ---- 2. And mailed, certified ----
    await page.getByLabel('How was it served?').selectOption('CERTIFIED_MAIL')
    await page.getByLabel('When was it served?').fill(localInputValue(1, property.timezone))
    await page.getByLabel('Certified-mail article number').fill('9407 1000 0000 0000 0000 22')
    await page.getByLabel('Carrier').fill('USPS')
    await page.getByRole('button', { name: 'Record service' }).click()
    await expect(page.getByText(/9407 1000/)).toBeVisible()

    // BOTH survive, each with its own evidence.
    const deliveries = await prisma.noticeDelivery.findMany({
      where: { noticeId: notice.id },
      orderBy: { servedAt: 'asc' },
      include: { proofDocument: true },
    })
    expect(deliveries.map((d) => d.method)).toEqual(['POSTED_WITH_PHOTO', 'CERTIFIED_MAIL'])
    expect(deliveries[0].proofDocumentId).not.toBeNull()
    expect(deliveries[0].proofDocument?.type).toBe('NOTICE_PROOF')
    expect(deliveries[1].trackingNumber).toContain('9407')
    // Texas lists both for a notice to vacate, so both are verified against
    // the configured rule rather than merely recorded.
    expect(deliveries[0].permittedByJurisdiction).toBe(true)
    expect(deliveries[1].permittedByJurisdiction).toBe(true)
    expect(deliveries[0].jurisdictionRuleId).not.toBeNull()

    // The Notice's own columns carry the FIRST service and are not rewritten
    // by the second.
    const updated = await prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })
    expect(updated.serviceMethod).toBe('POSTED_WITH_PHOTO')
    expect(updated.servedAt).not.toBeNull()

  })

  test('the SERVER refuses a posted service with no photograph, not just the browser', async ({
    page,
  }) => {
    // The whole evidentiary value of POSTED_WITH_PHOTO is the photograph.
    // `required` on the input is an affordance a form post can ignore, so the
    // attribute is stripped before submitting - which is what makes this a
    // test of the server guard rather than of the browser's validation.
    const { property, notice } = await seedNotice()
    const staff = await createStaff('manager', property.id)
    await signInStaff(page, staff.email)

    await page.goto(`/notices/${notice.id}`)
    await page.getByLabel('How was it served?').selectOption('POSTED_WITH_PHOTO')
    await page.getByLabel('When was it served?').fill(localInputValue(2, property.timezone))
    await page
      .getByLabel('Photo of the posted notice')
      .evaluate((el) => el.removeAttribute('required'))
    await page.getByRole('button', { name: 'Record service' }).click()

    await expect(page.getByText('A photo of the posted notice is required.')).toBeVisible()
    expect(await prisma.noticeDelivery.count({ where: { noticeId: notice.id } })).toBe(0)
  })

  test('flags a method this state does not permit, and still records it', async ({ page }) => {
    // A WARNING, NOT A REFUSAL. Texas does not list EMAIL for a notice to
    // vacate — but refusing to record what an operator actually did produces
    // no evidence at all, which is worse than evidence carrying a flag.
    const { property, notice } = await seedNotice()
    const staff = await createStaff('manager', property.id)
    await signInStaff(page, staff.email)

    await page.goto(`/notices/${notice.id}`)
    await page.getByLabel('How was it served?').selectOption('EMAIL')
    await expect(page.getByText(/do not list that method/)).toBeVisible()

    await page.getByLabel('When was it served?').fill(localInputValue(2, property.timezone))
    await page.getByRole('button', { name: 'Record service' }).click()
    await expect(page.getByText('Service recorded.')).toBeVisible()

    const delivery = await prisma.noticeDelivery.findFirstOrThrow({
      where: { noticeId: notice.id },
    })
    expect(delivery.method).toBe('EMAIL')
    expect(delivery.permittedByJurisdiction).toBe(false)
    await expect(page.getByText(/NOT permitted in this jurisdiction/)).toBeVisible()
  })

  test('generates the PDF once and archives it as the served artifact', async ({ page }) => {
    const { property, notice } = await seedNotice()
    const staff = await createStaff('manager', property.id)
    await signInStaff(page, staff.email)

    await page.goto(`/notices/${notice.id}`)
    await page.getByRole('button', { name: 'Generate the PDF' }).click()
    await expect(page.getByText(/archived\. This is the exact file/)).toBeVisible()

    const stored = await prisma.notice.findUniqueOrThrow({
      where: { id: notice.id },
      include: { document: true },
    })
    expect(stored.document?.contentType).toBe('application/pdf')
    expect(stored.document?.type).toBe('NOTICE')
    expect(stored.document?.sha256).toHaveLength(64)

    // It downloads, and it is a real PDF.
    const download = await page.request.get(`/api/documents/${stored.documentId}/file`)
    expect(download.status()).toBe(200)
    const body = await download.body()
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // Generating again does not mint a SECOND artifact - re-rendering after
    // service would produce a different file for the same served notice.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Generate the PDF' })).toHaveCount(0)
    expect(
      await prisma.document.count({ where: { propertyId: property.id, type: 'NOTICE' } }),
    ).toBe(1)
  })

  test('THE TENANT OPENING IT IS THE READ RECEIPT — and it does not move on a second visit', async ({
    browser,
  }) => {
    const { property, notice, tenant } = await seedNotice()
    await prisma.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method: 'PORTAL',
        servedAt: new Date('2026-08-16T15:00:00Z'),
      },
    })
    await prisma.notice.update({
      where: { id: notice.id },
      data: { serviceMethod: 'PORTAL', servedAt: new Date('2026-08-16T15:00:00Z') },
    })

    const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
    try {
      const page = await context.newPage()
      await page.goto(await magicLinkFor(tenant.id))
      await page.goto('/portal/notices')
      await expect(page.getByText('New')).toBeVisible()

      // Not read until the notice itself is opened: a list showing "About
      // your home" is not the tenant reading the notice.
      let delivery = await prisma.noticeDelivery.findFirstOrThrow({
        where: { noticeId: notice.id, method: 'PORTAL' },
      })
      expect(delivery.readAt).toBeNull()

      await page.getByRole('link', { name: /About your home/ }).click()
      await expect(page.getByText(/must vacate/)).toBeVisible()

      delivery = await prisma.noticeDelivery.findFirstOrThrow({
        where: { noticeId: notice.id, method: 'PORTAL' },
      })
      expect(delivery.readAt).not.toBeNull()
      const firstRead = delivery.readAt!

      // A second visit does not move it: the evidence is when they FIRST
      // read it, and the database refuses to change it anyway.
      await page.reload()
      await expect(page.getByText(/must vacate/)).toBeVisible()
      const after = await prisma.noticeDelivery.findFirstOrThrow({
        where: { noticeId: notice.id, method: 'PORTAL' },
      })
      expect(after.readAt?.toISOString()).toBe(firstRead.toISOString())

      // And the staff side can see it landed.
      const staff = await createStaff('manager', property.id)
      const staffPage = await browser.newPage()
      try {
        await signInStaff(staffPage, staff.email)
        await staffPage.goto(`/notices/${notice.id}`)
        await expect(staffPage.getByText(/Read by the tenant/)).toBeVisible()
      } finally {
        await staffPage.close()
      }
    } finally {
      await context.close()
    }
  })

  test('a tenant cannot open another tenancy’s notice', async ({ browser }) => {
    const mine = await seedNotice()
    const theirs = await seedNotice()
    await prisma.noticeDelivery.create({
      data: {
        noticeId: theirs.notice.id,
        method: 'PORTAL',
        servedAt: new Date('2026-08-16T15:00:00Z'),
      },
    })
    await prisma.notice.update({
      where: { id: theirs.notice.id },
      data: { serviceMethod: 'PORTAL', servedAt: new Date('2026-08-16T15:00:00Z') },
    })

    const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
    try {
      const page = await context.newPage()
      await page.goto(await magicLinkFor(mine.tenant.id))

      // 404, not 403 (ROLE-01): "forbidden" would confirm the record exists.
      const response = await page.request.get(`/portal/notices/${theirs.notice.id}`)
      expect(response.status()).toBe(404)

      // And no receipt was written for somebody else's notice.
      const delivery = await prisma.noticeDelivery.findFirstOrThrow({
        where: { noticeId: theirs.notice.id, method: 'PORTAL' },
      })
      expect(delivery.readAt).toBeNull()
    } finally {
      await context.close()
    }
  })

  test('accessibility — the notice register and the serve form have no violations', async ({
    page,
  }) => {
    const { property, notice } = await seedNotice()
    const staff = await createStaff('manager', property.id)
    await signInStaff(page, staff.email)

    await page.goto('/notices')
    const list = await axeScan(page)
    expect(list.violations).toEqual([])

    await page.goto(`/notices/${notice.id}`)
    const detail = await axeScan(page)
    expect(detail.violations).toEqual([])
  })
})

test.afterAll(async () => {
  // NoticeDelivery is append-only and RESTRICTs everything it points at, so
  // notices, leases, properties and the documents behind the proof all stay.
  // Only the roots are deactivated - the same pattern every suite touching an
  // append-only table has had to adopt.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})
