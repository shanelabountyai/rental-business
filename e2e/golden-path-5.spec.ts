import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// GOLDEN PATH 5 — the money path (Demo checkpoint 5, D-28).
//
// ==========================================================================
// THE WALK CHECKPOINTS 3 AND 4 BOTH WROTE DOWN AND NEITHER DID.
//
// Both of their PROGRESS entries end with the same sentence: the money path
// has no equivalent walk, and its items make promises of the same kind about
// what automation must not do to a protected tenancy. This is that walk, and
// it is the third time of asking.
//
// THE THESIS, and it is not checkpoint 3's or checkpoint 4's. Checkpoint 3
// asked what leaks. Checkpoint 4 asked what an unauthenticated stranger is
// allowed to cause. This one asks:
//
//   WHEN THE LAW PUTS A FENCE AROUND A TENANCY, WHAT MUST THE COLLECTIONS
//   MACHINE STOP DOING — AND WHAT MUST THE FENCE NEVER FORGIVE?
//
// Milestone 8 built the fence in six types (R-084) and one statute that
// raises it by itself (R-085). Milestone 4 built the machine that chases
// arrears (R-044). They were built four milestones apart and meet nowhere in
// the suite: lib/holds/holds.test.ts proves `leasesHalted` returns the right
// SET, scra.spec.ts proves a certificate places the hold, rent-roll.spec.ts
// proves the chase chases. Nothing joins the three, and the join is where an
// operator actually lives — one tenancy, over time, as its legal status
// changes underneath a screen somebody is already looking at.
//
// So one person is followed the whole way. She falls behind and is chased,
// which is lawful and correct. A DMDC certificate comes back in_service and
// the SCRA hold places itself — the only automatic hold in the product. From
// that moment:
//
//   * THE CHASE MUST STOP. Not because somebody remembered to stop it, but
//     because the screen no longer offers it.
//   * THE DEBT MUST NOT MOVE. R-084's own header: "Not the ledger — the debt
//     still exists and still shows on the rent roll. This stops the product
//     from ASKING for it."
//
// BOTH HALVES, OR NEITHER PROVES ANYTHING — the shape checkpoint 4 settled
// on. If the balance vanished with the chase, the product would have quietly
// forgiven a debt nobody decided to forgive. If the chase survived, the
// product would have violated a federal protection while displaying a banner
// saying it was in force. Only the contrast tells a guard from an off switch.
//
// THE GATE AT THE END is the race R-084's own text claims to defend: "a hold
// placed while the screen was open stops the chase the same way a payment
// does". So the chase is loaded, selected, and pressed AFTER the hold lands
// in another session. It must refuse — and it must say why it refused,
// because under a protection the reason a chase was withheld is the record.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []
const staffIds: string[] = []
const templateIds: string[] = []

/// PORTFOLIO-WIDE AND MFA-ENROLLED, and both halves are load-bearing here.
/// `/leases/[id]`'s DMDC panel needs the unscoped grant scra.spec.ts records
/// (a property-scoped manager lands on /no-access), and the rent roll needs
/// `ledger.read` + `message.send`. One actor crosses both screens because
/// one actor crosses both screens in real life.
async function seedOwner(legalEntityId: string) {
  const email = `gp5-owner-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'GP5 Owner',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
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
  return { ...staff, secret }
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

function daysAgo(days: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

test.beforeEach(async ({ page }) => {
  // D-130. R-003 limits sign-in to ten attempts per IP per five minutes and
  // local e2e traffic carries no x-forwarded-for.
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // Nothing is deleted that an append-only table points at. LeaseHold and
  // ScraLookup both hold StaffUser with Restrict, and every action here
  // writes an audit row.
  await prisma.messageTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

test('Golden Path 5: what the fence stops, and what it must not forgive', async ({
  page,
  browser,
}) => {
  // Three items end to end across two browser contexts, and the acceptance
  // gate for a milestone rather than a unit of one.
  test.setTimeout(180_000)

  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `GP5 LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `GP5 House-${unique}`,
      addressLine1: '9 Garrison Road',
      city: 'Killeen',
      // TEXAS on purpose, and for the same reason checkpoint 4 chose it: the
      // grace period this walk measures "past grace" against is the real
      // seeded rule read through `selectApplicableRule`, not a number this
      // file invented (D-4).
      state: 'TX',
      postalCode: '76541',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })

  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Mabel',
      lastName: `Keeler-${unique}`,
      email: `mabel-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)

  // TWENTY DAYS LATE: past grace under any rule Texas has ever carried, so
  // the walk does not turn on the exact number. `rentDueDay` matches the
  // fabricated charge's own due date deliberately — rent-roll.spec.ts's own
  // fixture records why leaving them to disagree ages the row from a date
  // nothing else refers to.
  const dueDate = daysAgo(20)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      rentDueDay: dueDate.getUTCDate(),
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const charge = await prisma.charge.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'RENT',
      amountCents: 150_000,
      description: 'Rent',
      dueOn: dueDate,
    },
  })
  await prisma.ledgerEntry.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      chargeId: charge.id,
      type: 'CHARGE',
      amountCents: 150_000,
      occurredAt: dueDate,
      description: 'Rent',
    },
  })

  const staff = await seedOwner(entity.id)
  const template = await prisma.messageTemplate.create({
    data: {
      name: `GP5 rent reminder ${unique}`,
      kind: 'ROUTINE',
      subject: 'Rent is overdue at {{property.address}}',
      body: 'Hi {{tenant.first_name}}, {{balance.total}} is outstanding on your account.',
      createdByStaffId: staff.id,
    },
  })
  templateIds.push(template.id)

  await signIn(page, staff)

  // ========================================================================
  // LEG 1 — THE MACHINE WORKS, AND IT IS SUPPOSED TO.
  //
  // Everything after this is about switching a thing off, and a test that
  // never saw it on proves nothing about the switch. This is the same
  // reasoning holds.test.ts's own late-fee test states for asserting the
  // held and unheld lease in one run.
  // ========================================================================
  await page.goto('/money/rent-roll')
  const row = page.getByRole('row').filter({ hasText: `Keeler-${unique}` })
  await expect(row).toBeVisible()
  await expect(row.getByText('past grace')).toBeVisible()
  await expect(row.getByText('$1,500.00').first()).toBeVisible()

  await row.getByRole('checkbox', { name: `Chase Mabel Keeler-${unique}` }).check()
  await page.getByLabel('Template').selectOption(template.id)
  await page.getByRole('button', { name: /Send reminder/ }).click()
  await expect(page.getByText(/Reminder sent to 1 tenant/)).toBeVisible()

  // Asserted at the notification engine rather than at the screen, because
  // the screen is R-044's own surface and the promise being checked is
  // R-030's: every module sends through the engine.
  const chaseRows = { category: 'rent_reminder', recipientType: 'TENANT', recipientId: tenant.id } as const
  const afterFirstChase = await prisma.notification.count({ where: chaseRows })
  expect(
    afterFirstChase,
    'the ordinary chase must actually send before we switch it off',
  ).toBeGreaterThan(0)

  // ========================================================================
  // LEG 2 — THE CHASE IS LOADED AND AIMED BEFORE THE FENCE EXISTS.
  //
  // The rent roll is re-rendered and Mabel is selected, and NOTHING IS
  // PRESSED. This is the state R-084 claims to defend against by name: a
  // screen already open, a selection already made, and the tenancy's legal
  // status about to change underneath it. A guard that only lives in the
  // render is no guard at all here, because the render already happened.
  // ========================================================================
  await page.goto('/money/rent-roll')
  await page.getByRole('row')
    .filter({ hasText: `Keeler-${unique}` })
    .getByRole('checkbox', { name: `Chase Mabel Keeler-${unique}` })
    .check()
  await page.getByLabel('Template').selectOption(template.id)

  // ========================================================================
  // LEG 3 — THE FENCE RAISES ITSELF, IN SOMEBODY ELSE'S SESSION.
  //
  // A second context, because this is a second person: the PM who reads the
  // certificate in is not the person holding the rent roll open. Its own
  // forwarded-for, because a new context does NOT inherit the one set on
  // `page` — the half of D-130 that even the specs which remembered got
  // wrong.
  //
  // Recording the search is R-085's surface and placing the hold is R-084's,
  // and no test crosses them: scra.spec.ts asserts the LeaseHold row appears,
  // and stops there. What that row then DOES is this walk's whole subject.
  // ========================================================================
  const second = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  try {
    const desk = await second.newPage()
    await signIn(desk, staff)
    await desk.goto(`/leases/${lease.id}`)
    await expect(desk.getByRole('heading', { name: /under a hold/i })).toHaveCount(0)

    await desk.getByLabel('Who was searched for').selectOption(tenant.id)
    await desk.getByLabel('Date the search was run').fill('2026-08-15')
    await desk.getByLabel('What the certificate says').selectOption('in_service')
    await desk.getByLabel('Certificate reference').fill(`DMDC-GP5-${unique}`)
    await desk.getByRole('button', { name: 'Record this search' }).click()
    await expect(desk.getByRole('heading', { name: /under a hold/i })).toBeVisible()
  } finally {
    // A leaked context surfaces as an unrelated spec failing on somebody
    // else's page.
    await second.close()
  }

  const hold = await prisma.leaseHold.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'MILITARY_SCRA', liftedAt: null },
  })
  expect(hold.reason).toContain(`DMDC-GP5-${unique}`)

  // ========================================================================
  // THE GATE, PART ONE — THE PRESS THAT IS ALREADY AIMED.
  //
  // Nothing on `page` knows the fence went up. The button was rendered
  // chaseable, the checkbox is ticked, the template is chosen. R-044
  // re-reads the fact from the database "immediately before anything is
  // sent" precisely so this press cannot land.
  //
  // And it must say WHY. A chase withheld under a federal protection is a
  // thing somebody asks about three weeks later, and "not past the grace
  // period" is not merely unhelpful — it is FALSE, and it is the sentence
  // that makes an operator conclude the tenant paid and go looking for a
  // payment that does not exist.
  // ========================================================================
  await page.getByRole('button', { name: /Send reminder/ }).click()
  await expect(page.getByText(/Nothing was sent/)).toBeVisible()
  await expect(page.getByText(/hold/i).first()).toBeVisible()
  await expect(page.getByText(/not past the grace period/)).toHaveCount(0)

  // NOT ONE ROW MORE THAN LEG 1 LEFT BEHIND. Compared against the count
  // taken then rather than asserted as a literal, because `notify` fans one
  // logical notification out to one row PER CHANNEL — a tenant with an email
  // address and a phone is three rows for one send, and a spec that hard-
  // codes the number is really asserting how many channels the tenant
  // happened to have. The claim here is about the refused press, so the
  // comparison is against the state the refused press started from.
  //
  // Asked at the engine, because "did we send it" is not answerable from a
  // screen that has already been told the send was refused.
  expect(await prisma.notification.count({ where: chaseRows })).toBe(afterFirstChase)

  // The audit row carries the same reason, and this is the half that
  // outlives the session. reminders.ts records the skips rather than
  // counting them for exactly this question.
  const bulk = await prisma.auditLog.findFirst({
    where: { action: 'message.bulk_sent', entityId: template.id },
    orderBy: { occurredAt: 'desc' },
  })
  expect(JSON.stringify(bulk?.after ?? {})).toMatch(/hold/i)

  // ========================================================================
  // THE GATE, PART TWO — AND THE DEBT DID NOT MOVE.
  //
  // The screen is reloaded, now with the fence in force. Both halves in one
  // place, because either alone passes for the wrong reason:
  //
  //   * the chase is not offered — no checkbox, and the row says why, which
  //     is the rule rent-roll-table.tsx's own header states and the hold
  //     case was the one exception to it;
  //   * the balance is still $1,500.00 and still in a late bucket. R-084
  //     stops the product ASKING for the debt. It does not forgive it, and a
  //     product that quietly did would be making a decision nobody made.
  // ========================================================================
  await page.goto('/money/rent-roll')
  const held = page.getByRole('row').filter({ hasText: `Keeler-${unique}` })
  await expect(held).toBeVisible()

  await expect(held.getByRole('checkbox')).toHaveCount(0)
  await expect(held.getByText(/chase paused by a hold/i)).toBeVisible()

  await expect(held.getByText('$1,500.00').first()).toBeVisible()
  await expect(held.getByText('Current')).toHaveCount(0)

  // And she is not counted among the people the bulk control offers to
  // chase. "Select all N past grace" is the control an operator actually
  // uses, and a count that still includes a tenancy under an automatic stay
  // is the mistake this walk exists to make impossible.
  await expect(page.getByText(/Select all .* past grace/)).toHaveCount(0)
})
