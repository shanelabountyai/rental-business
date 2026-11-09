import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, expect, it } from 'vitest'
import { notify } from './send.ts'

// R-268 (D-405): an org's saved greeting and closing reach the recorded
// message through notify(), and only that org's. Its own org, so no other
// file's rent reminder ever reads this wording from the shared database.

const stamp = randomUUID().slice(0, 8)
let orgId: string

afterAll(async () => {
  await prisma.$disconnect()
})

it("records a rent reminder in the org's own wording, and nobody else's", async () => {
  const org = await prisma.organization.create({ data: { slug: `wording-${stamp}`, name: 'Wording Co' } })
  orgId = org.id
  await prisma.messagingSettings.create({
    data: {
      id: orgId,
      orgId,
      templateWording: { 'payment.due_soon': { greeting: 'Dear', closing: 'Call 555-0100.' } },
    },
  })
  const context = {
    tenantName: 'Ada',
    addressLine1: '1 Wording Way',
    amount: '$1,000.00',
    dueOn: '2026-12-01',
    isDueToday: false,
  }
  const send = (org: string) =>
    notify({
      category: 'rent_reminder',
      templateKey: 'payment.due_soon',
      recipient: { type: 'TENANT', id: `wording-${stamp}-${org}`, email: `wording-${stamp}@example.test` },
      context,
      orgId: org,
      idempotencyKey: `wording-${stamp}-${org}`,
      channels: ['EMAIL'],
    })
  await send(orgId)
  await send('org_0')

  const [mine, theirs] = await Promise.all(
    [orgId, 'org_0'].map((org) =>
      prisma.notification.findFirstOrThrow({
        where: { idempotencyKey: { startsWith: `wording-${stamp}-${org}` } },
        select: { body: true },
      }),
    ),
  )
  expect(mine.body.startsWith('Dear Ada,')).toBe(true)
  expect(mine.body.endsWith('Call 555-0100.')).toBe(true)
  expect(theirs.body.startsWith('Hello Ada,')).toBe(true)
  expect(theirs.body).not.toContain('555-0100')
})
