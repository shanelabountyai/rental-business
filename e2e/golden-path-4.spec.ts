import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// GOLDEN PATH 4 — the stranger's path (Demo checkpoint 4, D-28).
//
// ==========================================================================
// MILESTONE 9 SHIPPED WITH NO CHECKPOINT, THE SAME WAY MILESTONE 8 DID.
//
// R-097f's own PROGRESS entry says so in as many words, and D-28 exists
// because the four defects checkpoint 1 found were every one of them
// invisible from inside the item that introduced it. Checkpoint 3 then found
// three more. So this is the gate Milestone 9 owes.
//
// THE THESIS. Milestone 9 built two surfaces the OUTSIDE WORLD drives and
// neither of which can authenticate anybody: a smart-lockbox self-showing
// (R-094, R-094b) and inbound email (R-097a/d/e/f). A stranger types a name
// into a page; a stranger sends a From: header. Both are as trustworthy as
// caller ID, and both are allowed to cause real things - a door opening, a
// maintenance ticket, a permanent line in somebody's evidence trail.
//
// So the question this walks is not "does it leak" (that was checkpoint 3)
// but: WHAT IS AN UNAUTHENTICATED STRANGER ALLOWED TO CAUSE, and what must
// they never be able to cause? One person is followed the whole way - a
// stranger who books a viewing, moves in, and emails about a boiler - and
// each item's promise is asserted against a SURFACE THAT ITEM DOES NOT OWN.
//
// The gate at the end is the sharpest one in the milestone. R-097e's own
// header names the outcome it fears: "a tenant who believes they have
// switched off every email, misses an entry notice, and finds somebody in
// their home". Here that tenant switches off every email they can, and then
// the visit their own email caused is scheduled. The entry notice must
// survive the opt-out. The "did we fix it?" follow-up must not.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'
const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET ?? ''

const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []

/// A real JPEG header and nothing after it. The store records the DECLARED
/// content type and never trusts it (R-097d), so the bytes only have to be
/// bytes - and keeping the fixture to a handful of them means the walk is
/// testing the plumbing rather than a base64 blob's round trip.
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

async function createOwner(legalEntityId: string) {
  const unique = randomUUID().slice(0, 8)
  const email = `gp4-owner-${unique}@example.test`
  const enrolment = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `GP4 Owner ${unique}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(enrolment.secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId },
  })
  return { ...staff, secret: enrolment.secret }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

/// An access token for a showing happening RIGHT NOW - the only state in
/// which the page will show a code. Minted directly because `issueToken()`
/// is server-only and cannot load into Playwright's plain-Node context, the
/// same reason self-showing.spec.ts mints its own.
async function accessTokenFor(showingId: string) {
  const minted = mintToken('SHOWING_ACCESS')
  await prisma.authToken.create({
    data: {
      purpose: 'SHOWING_ACCESS',
      tokenHash: minted.tokenHash,
      subjectType: 'Showing',
      subjectId: showingId,
      expiresAt: minted.expiresAt,
    },
  })
  return minted.token
}

/// Posts to the real webhook rather than calling `handleInboundEmail`, which
/// is `server-only`. That is not a compromise: the route is the only thing a
/// stranger can actually reach, and the secret check, the From: parsing and
/// the base64 decode are all part of what this walk is about.
async function inboundEmail(
  request: import('@playwright/test').APIRequestContext,
  payload: Record<string, unknown>,
) {
  const response = await request.post('/api/email/inbound', {
    headers: { 'x-inbound-secret': INBOUND_SECRET },
    data: payload,
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as { outcome: string }
}

test.beforeEach(async ({ page }) => {
  // R-003's login limiter is ten attempts per IP per five minutes and local
  // e2e traffic carries no x-forwarded-for. D-130: without this, specs share
  // one bucket and the sweep starts refusing sign-ins around test 200, in
  // whichever file happens to be running.
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('Golden Path 4: what a stranger is allowed to cause', async ({ page, browser }) => {
  // Longer than the default: this walks six items end to end and is the
  // acceptance gate for a whole milestone, not a unit of one.
  test.setTimeout(180_000)

  // The secret is asserted rather than assumed. Without it the route answers
  // 503 to everything, which is CORRECT - and the whole email half of this
  // walk would then "pass" having proved nothing, exactly the failure mode
  // playwright.config.ts's Twilio token comment describes.
  expect(INBOUND_SECRET, 'INBOUND_EMAIL_SECRET must be set for this walk').not.toBe('')

  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `GP4 LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `GP4 House-${unique}`,
      addressLine1: '14 Stranger Street',
      city: 'Houston',
      // TEXAS on purpose: the entry notice at the end is measured against the
      // real seeded 24-hour rule read through rulesFor(), not an invented
      // number (D-4).
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  await prisma.smartLock.create({
    data: { unitId: unit.id, externalId: `dev-gp4-${unique}`, label: 'Front door keypad' },
  })

  // The stranger. One email address, carried the whole way: the person who
  // books a viewing is the person who later emails about a boiler, and the
  // walk is only worth anything if it is the same person throughout.
  const strangerEmail = `dorothy-${unique}@example.test`
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: property.id,
      listingId: listing.id,
      firstName: 'Dorothy',
      lastName: `Vaughan-${unique}`,
      email: strangerEmail,
      source: 'TEST',
      status: 'SHOWING',
    },
  })

  const owner = await createOwner(entity.id)

  const bookNow = async () => {
    const start = new Date()
    return prisma.showing.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        prospectId: prospect.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 30 * 60_000),
      },
    })
  }

  // ==================================================================
  // 1. R-094 — A STRANGER AT THE DOOR.
  //    What they may cause: a door opening, inside a window, on a
  //    vacant home, under a name WE matched.
  // ==================================================================

  // D-116: a genuine licence belonging to somebody else comes back VERIFIED
  // from any provider. Only this system knows who booked the slot, so the
  // comparison has to be ours - and D-27 is what makes the simulator answer
  // with the name it was TOLD, or this branch is unreachable.
  const impostorShowing = await bookNow()
  await page.goto(`/showings/access/${await accessTokenFor(impostorShowing.id)}`)
  await page
    .getByLabel('Your name exactly as it is printed on your photo ID')
    .fill('Katherine Johnson')
  await page.getByRole('button', { name: 'Confirm who I am' }).click()
  await expect(
    page.getByText('does not match the name this viewing was booked under'),
  ).toBeVisible()
  expect(
    await prisma.showingAccess.count({ where: { showingId: impostorShowing.id } }),
    'a refused identity check leaves no access row at all',
  ).toBe(0)

  const showing = await bookNow()
  const accessToken = await accessTokenFor(showing.id)
  const strangerContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const strangerPage = await strangerContext.newPage()
  try {
    await strangerPage.goto(`/showings/access/${accessToken}`)
    // Nothing is offered before they say who they are.
    await expect(strangerPage.getByText(/Your entry code/)).toHaveCount(0)
    await strangerPage
      .getByLabel('Your name exactly as it is printed on your photo ID')
      .fill(`Dorothy Vaughan-${unique}`)
    await strangerPage.getByRole('button', { name: 'Confirm who I am' }).click()
    await expect(strangerPage.getByText('Your entry code')).toBeVisible()

    // D-108 applied to a stranger: the check is four columns and a provider
    // reference. Asserted at the DOCUMENT table - the place a photo ID would
    // have to land - rather than at the identity-check row that owns it.
    const access = await prisma.showingAccess.findUniqueOrThrow({
      where: { showingId: showing.id },
      include: { identityCheck: true },
    })
    expect(access.identityCheck.result).toBe('VERIFIED')
    expect(
      await prisma.document.count({ where: { propertyId: property.id } }),
      'no photo ID is stored anywhere, ever',
    ).toBe(0)

    // D-115: the WINDOW is the control, not the link - so the code lives on
    // a page and in no message. Asserted against the notification engine,
    // which is not R-094's table.
    const sixDigits = /\b\d{6}\b/
    for (const sent of await prisma.notification.findMany({
      where: { recipientId: prospect.id },
      select: { body: true },
    })) {
      expect(sent.body, 'no code in anything we sent them').not.toMatch(sixDigits)
    }

    // D-117: the kill is the cheap path, and the decision is re-run on every
    // render - so nothing has to be recalled and nothing has to expire.
    await signIn(page, owner)
    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    const lockPanel = page.getByRole('region', { name: 'Smart lock and self-showings' })
    await lockPanel.getByLabel('Why the code is being pulled').fill('They took another house.')
    await lockPanel.getByRole('button', { name: 'Pull this entry code now' }).click()
    // The PERSISTED line on the row, not the action's transient notice: a
    // successful revoke unmounts the form that would have rendered it.
    await expect(lockPanel.getByText('They took another house.')).toBeVisible()

    await strangerPage.reload()
    await expect(strangerPage.getByText('Your entry code')).toHaveCount(0)
    await expect(strangerPage.getByText('has been cancelled')).toBeVisible()
  } finally {
    await strangerContext.close()
  }

  // ==================================================================
  // 2. THE STRANGER MOVES IN — and R-094's hardest rule is asserted
  //    against a state change LEASING made, not showings.
  // ==================================================================
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Dorothy',
      lastName: `Vaughan-${unique}`,
      email: strangerEmail,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  await prisma.unit.update({ where: { id: unit.id }, data: { status: 'OCCUPIED' } })
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      rentCents: 150_000,
      // Zero, so R-069's move-in-funds gate is satisfied without a deposit
      // fixture. That gate has its own coverage and is not what this walks.
      depositCents: 0,
      rentDueDay: 1,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })

  // D-115's outranking rule: an unaccompanied code on an occupied home is a
  // stranger with a key to somebody's house. The unit's status was changed by
  // a move-in, and nobody told the showings feature - which is exactly why
  // this is worth asserting from out here.
  const afterMoveIn = await bookNow()
  const laterContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const laterPage = await laterContext.newPage()
  try {
    await laterPage.goto(`/showings/access/${await accessTokenFor(afterMoveIn.id)}`)
    await expect(laterPage.getByText('Somebody is living here now')).toBeVisible()
    // Not merely refused after asking - the ID form is not even offered, so
    // there is no path from here to a code.
    await expect(
      laterPage.getByLabel('Your name exactly as it is printed on your photo ID'),
    ).toHaveCount(0)
  } finally {
    await laterContext.close()
  }

  // ==================================================================
  // 3. R-094b — THE SAME DOOR, NOW HERS.
  //    One code per person (D-118), and the audit records that the
  //    DOOR was programmed, never the code.
  // ==================================================================
  await page.goto(`/leases/${lease.id}`)
  const doorPanel = page.getByRole('region', { name: 'Door codes' })
  await doorPanel.getByRole('button', { name: 'Give them a door code' }).click()
  await expect(doorPanel.getByText('Shown once')).toBeVisible()

  const doorCode = await prisma.tenantLockCode.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(doorCode.tenantId, 'the code belongs to a PERSON, not a household').toBe(tenant.id)
  expect(doorCode.issuedByStaffId).toBe(owner.id)
  expect(doorCode.revokedAt).toBeNull()
  const issuedAudit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: lease.id, action: 'accesscode.issued' },
  })
  expect(issuedAudit.after).toMatchObject({ programmedAtDevice: true, tenantId: tenant.id })
  // D-119: a device that refuses an ISSUE writes no row at all, so a row
  // existing means the door heard it. The sealed code is never in the trail.
  expect(JSON.stringify(issuedAudit.after)).not.toContain(doorCode.sealedCode)

  // ==================================================================
  // 4. R-097a/d/f — THE SAME STRANGER, NOW BY EMAIL.
  //    What a From: header may cause: a threaded message, a stored
  //    photograph, and a ticket in somebody's work queue.
  // ==================================================================
  const opened = await inboundEmail(page.request, {
    from: `Dorothy <${strangerEmail}>`,
    to: 'hello@example.test',
    subject: 'urgent!!! please read',
    text: 'The boiler is leaking all over the utility room floor.\n\nOn Monday you wrote:\n> Welcome to your new home!',
    'message-id': `gp4-repair-${unique}@example.test`,
    attachments: [
      { filename: '../../etc/leak photo.jpg', contentType: 'image/jpeg', content: PHOTO.toString('base64') },
    ],
  })
  // No reply key configured and no outbound on this thread, so the evidence
  // says "somebody telling us something new" - which is the branch that opens
  // a ticket (D-128).
  expect(opened.outcome).toBe('ticket_opened')

  const ticket = await prisma.ticket.findFirstOrThrow({ where: { tenantId: tenant.id } })
  expect(ticket.source).toBe('EMAIL')
  expect(ticket.propertyId).toBe(property.id)
  expect(ticket.unitId).toBe(unit.id)
  // D-128: no category guessed from prose. R-023's triage assigns it from a
  // human reading the words, and R-019's structured intake is the only path
  // that earns one by asking.
  expect(ticket.category).toBe('UNCATEGORIZED')
  // The subject line is not matched on and is not the description - "urgent!!!
  // please read" would be a useless ticket title, and R-097a names subject
  // matching as the commonest way this feature leaks.
  expect(ticket.description).toContain('The boiler is leaking')
  expect(ticket.description).toContain('reply by email')
  // R-097a's quoted tail: Message is append-only, so the tail is CUT rather
  // than stored and hidden, or the third reply stores the first two for ever.
  expect(ticket.description).not.toContain('Welcome to your new home')

  // R-097d, and the half R-097f added: the photograph is hung off the TICKET,
  // not only the message - without which the person dispatched to fix the
  // leak never sees the picture. Asserted from the ticket's side.
  const photo = await prisma.document.findFirstOrThrow({ where: { ticketId: ticket.id } })
  expect(photo.propertyId).toBe(property.id)
  expect(photo.messageId, 'still filed on the message it arrived on').not.toBeNull()
  // Sanitised for DISPLAY as well as for the storage key: an unauthenticated
  // sender chose this filename.
  expect(photo.fileName).not.toContain('..')
  expect(photo.fileName).not.toContain('/')

  // ==================================================================
  // 5. R-097e — "STOP EMAILING ME", IN PROSE.
  //    What a From: header may cause: every switchable email off.
  //    What it may NOT cause: a maintenance ticket, or silence on the
  //    four categories NOTIF-02 locks on.
  // ==================================================================
  const optOut = await inboundEmail(page.request, {
    from: strangerEmail,
    to: 'hello@example.test',
    subject: 'Re: your message',
    text: 'Please unsubscribe me from all emails.',
    'message-id': `gp4-optout-${unique}@example.test`,
  })
  // NOT a second ticket. R-097e's check runs before the ticket decision, and
  // a maintenance ticket titled "please unsubscribe me" is the visible half
  // of getting that wrong.
  expect(optOut.outcome).toBe('threaded')
  expect(
    await prisma.ticket.count({ where: { tenantId: tenant.id } }),
    'an opt-out is not a repair request',
  ).toBe(1)

  const prefs = await prisma.notificationPreference.findMany({
    where: { recipientType: 'TENANT', recipientId: tenant.id, channel: 'EMAIL' },
  })
  expect(prefs.length, 'something was actually switched off').toBeGreaterThan(0)
  expect(prefs.every((row) => row.enabled === false)).toBe(true)
  // NOTIF-02's locked four are not even WRITTEN as rows. A preference row
  // saying `entry_notice: false` would be a tenant choice the product does
  // not allow, sitting in the table where somebody would later read it.
  expect(prefs.map((row) => row.category)).not.toContain('entry_notice')
  expect(prefs.map((row) => row.category)).toContain('rent_reminder')
  // The message that changed what we may send is itself in the conversation
  // rather than swallowed by the command - R-040e's rule for a STOP text, and
  // for the same reason.
  const optOutThread = await prisma.thread.findFirstOrThrow({ where: { tenantId: tenant.id } })
  expect(
    await prisma.message.count({
      where: { threadId: optOutThread.id, direction: 'INBOUND', body: { contains: 'unsubscribe' } },
    }),
  ).toBe(1)

  // ==================================================================
  // THE GATE. The visit her own email caused, scheduled against the
  // opt-out she just made. R-027 and R-097e have never met.
  // ==================================================================
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      scope: 'Replace the water heater.',
      priority: 'URGENT',
      status: 'APPROVED',
    },
  })

  const pad = (n: number) => String(n).padStart(2, '0')
  const localDateTime = (hoursFromNow: number) => {
    const at = new Date(Date.now() + hoursFromNow * 3_600_000)
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
  }

  await page.goto(`/workorders/${workOrder.id}`)
  await page.getByLabel('Window starts').fill(localDateTime(48))
  await page.getByLabel('Window ends').fill(localDateTime(51))
  await page.getByLabel('What the visit is for').fill('Replace the water heater')
  await page.getByRole('button', { name: 'Schedule and notify' }).click()
  // Poll the FACT the next assertions read, not a UI signal that resolves
  // before the write lands - CLAUDE.md's rule, and the defect checkpoint 3's
  // confirming sweep found.
  await expect
    .poll(
      async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
      { timeout: 20_000 },
    )
    .toBe('SCHEDULED')

  // ---- THE ASSERTION THIS WHOLE WALK EXISTS FOR ----
  // An entry notice is an obligation of OURS, not a subscription of hers. She
  // asked for no email and this one still goes, because the alternative is a
  // tenant who finds somebody in her home having been misled by us.
  const entryNotice = await prisma.notification.findFirstOrThrow({
    where: { recipientId: tenant.id, category: 'entry_notice', channel: 'EMAIL' },
    include: { delivery: true },
  })
  expect(entryNotice.delivery?.status, 'a locked category outranks any opt-out').not.toBe(
    'SUPPRESSED',
  )
  expect(entryNotice.delivery?.suppressedReason).toBeNull()
  expect(entryNotice.toAddress).toBe(strangerEmail)

  // ---- AND THE OTHER HALF, OR THE ONE ABOVE PROVES NOTHING ----
  // If everything survives an opt-out then the opt-out does not work, and
  // this assertion is what tells the two apart. Marking the job complete asks
  // the tenant to confirm (MAINT-07) - a `maintenance_update`, which is
  // switchable, and which she switched off.
  await page.goto(`/workorders/${workOrder.id}`)
  await page
    .getByRole('button', { name: 'Mark the work complete (asks the tenant to confirm)' })
    .click()
  await expect
    .poll(
      async () =>
        (
          await prisma.notification.findFirst({
            where: { recipientId: tenant.id, category: 'maintenance_update', channel: 'EMAIL' },
            include: { delivery: true },
          })
        )?.delivery?.status,
      { timeout: 20_000 },
    )
    .toBe('SUPPRESSED')
  const followUp = await prisma.notification.findFirstOrThrow({
    where: { recipientId: tenant.id, category: 'maintenance_update', channel: 'EMAIL' },
    include: { delivery: true },
  })
  // Recorded as her CHOICE, not as a gap of ours - D-38's distinction, which
  // is what makes "who did we fail to reach" answerable later.
  expect(followUp.delivery?.suppressedReason).toBe('preference_off')
})
