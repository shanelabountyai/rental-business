import { randomUUID } from 'node:crypto'
import { hashPassword, sealSecret } from '@rental/core/auth'
import { TURN_SEQUENCE } from '@rental/core/turnover'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Turnover / make-ready through the browser (LEASE-12, R-072).
//
// The idempotent project creation and the auto-drafted punch list are
// proved against directly-seeded rows in start.test.ts and
// punch-list.test.ts. What only a browser proves is here: a PM can add a
// checklist item, set a target date and mark the turn rent-ready from the
// unit page, and the unit actually flips MAKE_READY -> VACANT.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const projectIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `turnover-${unique}@example.test`,
      name: `Turnover Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedTurn(options: { leaseStatus?: string; withProject?: boolean } = {}) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Turn LLC-${unique}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Turn House-${unique}`,
      addressLine1: '5 Turnover Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const ended = (options.leaseStatus ?? 'ENDED') === 'ENDED'
  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `U-${unique}`,
      status: ended ? 'MAKE_READY' : 'OCCUPIED',
    },
  })
  unitIds.push(unit.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: (options.leaseStatus ?? 'ENDED') as never,
      startsOn: new Date('2025-01-01'),
      endsOn: new Date('2026-06-30'),
      rentCents: 150_000,
      moveOutAt: ended ? new Date('2026-06-30T18:00:00Z') : null,
    },
  })
  leaseIds.push(lease.id)
  if (options.withProject === false) return { property, unit, lease, project: null }
  const project = await prisma.turnoverProject.create({
    data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id },
  })
  projectIds.push(project.id)
  return { property, unit, lease, project }
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
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.accessCode.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.workOrder.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.turnoverProject.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test.describe('turnover', () => {
  test('a PM adds a checklist item, sets a target date, and marks the turn rent-ready', async ({ page }) => {
    const { property, unit, project: seededProject } = await seedTurn()
    // Non-null by construction - only the move-out test below opts out of
    // seeding a project, because it makes the real one.
    const project = seededProject!
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByRole('heading', { name: 'Turnover' }).scrollIntoViewIfNeeded()
    await expect(page.getByText('No punch-list items yet.')).toBeVisible()

    await page.getByLabel('Add checklist item').fill('Paint the living room')
    await page.getByLabel('Stage').selectOption('PAINT')
    await page.getByRole('button', { name: 'Add' }).click()

    await page.waitForURL(new RegExp(`/units/${unit.id}$`))
    await expect(page.getByRole('link', { name: 'Paint the living room' })).toBeVisible()

    const workOrder = await prisma.workOrder.findFirstOrThrow({ where: { turnoverProjectId: project.id } })
    expect(workOrder.turnoverStage).toBe('PAINT')

    await page.getByLabel('Target rent-ready date').fill('2026-07-15')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByLabel('Target rent-ready date')).toHaveValue('2026-07-15')

    // R-176. WARNED FIRST - this turn has no re-key recorded, and the press
    // refuses once rather than blocking. Seeded directly, so it never had
    // the re-key work order `startTurnoverProjectForLease` would have opened.
    await page.getByRole('button', { name: 'Mark rent-ready' }).click()
    await expect(page.getByText(/No re-key is recorded on this turn/)).toBeVisible()
    expect(
      (await prisma.turnoverProject.findUniqueOrThrow({ where: { id: project.id } })).rentReadyAt,
    ).toBeNull()

    await page
      .getByLabel('No re-key is recorded and I want to mark this rent-ready anyway')
      .check()
    await page.getByRole('button', { name: 'Mark rent-ready' }).click()
    // `\w+`, for the reason spelled out in access-codes-move-in.spec.ts.
    // The `\w{3,4}` this replaces was the same bug patched one line deep:
    // it happens to cover "Sept" and still encodes a month-length guess.
    await expect(page.getByText(/Rent-ready \d{1,2} \w+ \d{4}/)).toBeVisible()

    const updatedUnit = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updatedUnit.status).toBe('VACANT')

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'turnover.rent_ready', entityId: project.id } })
    // R-176: the override is on the record, which is the whole value of
    // warning instead of blocking.
    expect((entry.after as { rekeyRecorded?: boolean }).rekeyRecorded).toBe(false)
  })

  // R-176. The move-out itself, through the real status change - the two
  // halves the item exists for, and neither is reachable from the seeded
  // fixture above: ending the tenancy retires our record of the keypad code
  // (so no vendor reveal and no handoff packet can hand it to a stranger),
  // and the turn opens the re-key that actually changes the lock.
  test('ending a tenancy retires the unit access codes and opens a re-key', async ({ page }) => {
    const { property, unit, lease } = await seedTurn({
      leaseStatus: 'ACTIVE',
      withProject: false,
    })
    const code = await prisma.accessCode.create({
      data: {
        unitId: unit.id,
        type: 'LOCKBOX',
        label: 'Front door',
        sealedCode: sealSecret('7392', 'access-code'),
        version: 1,
      },
    })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page
      .getByLabel('Why is this tenancy being cut short?')
      .fill('Mutual release, tenant relocating')
    await page.getByRole('button', { name: 'Terminate this tenancy' }).click()
    await expect(page.getByText(/Mutual release, tenant relocating/)).toBeVisible()

    // The retire is INSIDE the status-change transaction, so it has landed
    // by the time the page comes back. The turn and its re-key are
    // post-commit best-effort, so poll for those.
    const after = await prisma.accessCode.findUniqueOrThrow({ where: { id: code.id } })
    expect(after.effectiveTo).not.toBeNull()

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: lease.id, action: 'accesscode.retired_on_move_out' },
    })
    expect((entry.after as { retiredCount?: number }).retiredCount).toBe(1)

    await expect
      .poll(async () =>
        prisma.workOrder.count({ where: { unitId: unit.id, turnoverStage: 'REKEY' } }),
      )
      .toBe(1)
    const project = await prisma.turnoverProject.findUniqueOrThrow({
      where: { leaseId: lease.id },
    })
    projectIds.push(project.id)

    // R-178. The whole template opened with the turn, not just the re-key -
    // six sequenced stages, on the board before anybody remembered them.
    await expect
      .poll(async () => prisma.workOrder.count({ where: { turnoverProjectId: project.id } }))
      .toBe(TURN_SEQUENCE.length)

    // ...and the sequence is on the screen. Scoped to the schedule table by
    // its caption: every stage name also appears in the punch-list rows below
    // and in the "Stage" select's own options, so an unscoped getByText for
    // any of them is ambiguous three ways over.
    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    const schedule = page.getByRole('table', {
      name: 'Each turn stage with its planned window and what it is waiting on',
    })
    await expect(schedule.getByRole('row', { name: /Floors/ })).toContainText(
      'waiting on Trash-out',
    )
    // R-176's urgent re-key must never read as blocked, whatever is ahead of
    // it in the checklist.
    await expect(schedule.getByRole('row', { name: /Re-key/ })).not.toContainText('waiting on')

    // ...and the retired code is gone from the operational panel, which is
    // what a vendor reveal and the handoff packet read from.
    //
    // NOT `getByText('Front door')`: the add-a-code form on this same page
    // carries `"Front door"` as its hint, and getByText is a case-insensitive
    // SUBSTRING match, so that assertion can never pass. The panel says
    // exactly this sentence when a unit has none.
    await expect(page.getByText('No codes on file.')).toBeVisible()
  })
})
