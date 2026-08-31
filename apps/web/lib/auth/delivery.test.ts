import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import { deliverAuthLink } from './delivery.ts'
import { issueToken } from './store.ts'

// R-139. The claim under test is the one that was false for seventeen months:
// calling this function actually RECORDS a message. The old body returned
// early on `NODE_ENV === 'production'` and wrote nothing anywhere, so a
// deployed environment sent no tenant magic link and no staff password reset.
//
// Recording is asserted rather than sending, deliberately - the provider is
// somebody else's network and `dispatchPendingNotifications` owns that half.
// A row in `Notification` is the durable fact, and R-106's retry sweep is what
// turns it into a delivery if the first attempt fails.

const staffIds: string[] = []

async function staffUser() {
  const user = await prisma.staffUser.create({
    data: {
      email: `delivery-${randomUUID()}@example.test`,
      name: 'Dana Reyes',
      credential: { create: { passwordHash: await hashPassword('correct-horse-battery-staple') } },
    },
  })
  staffIds.push(user.id)
  return user
}

async function sendOne(user: { id: string; email: string; name: string }, url: string) {
  const issued = await issueToken('STAFF_PASSWORD_RESET', { type: 'StaffUser', id: user.id })
  await deliverAuthLink({
    kind: 'staff_password_reset',
    recipient: { type: 'STAFF', id: user.id, name: user.name },
    to: user.email,
    url,
    expiresAt: issued.expiresAt,
    tokenId: issued.id,
  })
  return issued
}

afterAll(async () => {
  // `Notification` is append-only by trigger, so the rows this file writes
  // stay. They are dispatched rather than left QUEUED, so they are not the
  // debris a global sweep would later pay for (R-102).
  await prisma.authToken.deleteMany({ where: { subjectId: { in: staffIds } } })
  await prisma.staffCredential.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
})

describe('deliverAuthLink', () => {
  it('records an EMAIL notification carrying the link', async () => {
    const user = await staffUser()
    const url = `https://example.test/reset-password?token=${randomUUID()}`
    const issued = await sendOne(user, url)

    const notification = await prisma.notification.findUniqueOrThrow({
      where: { idempotencyKey: `auth-link:${issued.id}:EMAIL` },
    })
    expect(notification.category).toBe('account_access')
    expect(notification.channel).toBe('EMAIL')
    expect(notification.toAddress).toBe(user.email)
    expect(notification.recipientType).toBe('STAFF')
    expect(notification.recipientId).toBe(user.id)
    // The link has to be IN the message - that is what the message is.
    expect(notification.body).toContain(url)
    // No property, which is what keeps quiet hours out of it: `notify()` never
    // defers a notification with no property to defer against.
    expect(notification.propertyId).toBeNull()
  })

  it('sends a second link to the same person rather than swallowing it', async () => {
    const user = await staffUser()
    const first = await sendOne(user, 'https://example.test/reset-password?token=one')
    const second = await sendOne(user, 'https://example.test/reset-password?token=two')

    expect(second.id).not.toBe(first.id)
    const rows = await prisma.notification.findMany({
      where: { recipientType: 'STAFF', recipientId: user.id },
      select: { body: true },
    })
    // THE FAILURE THIS GUARDS: an idempotency key derived from the RECIPIENT
    // rather than the token would make the second reset a duplicate and send
    // nothing, which is the one thing a sign-in link cannot do.
    expect(rows).toHaveLength(2)
    expect(rows.some((row) => row.body.includes('token=one'))).toBe(true)
    expect(rows.some((row) => row.body.includes('token=two'))).toBe(true)
  })

  it('is idempotent for the same token', async () => {
    const user = await staffUser()
    const issued = await issueToken('STAFF_PASSWORD_RESET', { type: 'StaffUser', id: user.id })
    const input = {
      kind: 'staff_password_reset' as const,
      recipient: { type: 'STAFF' as const, id: user.id, name: user.name },
      to: user.email,
      url: 'https://example.test/reset-password?token=same',
      expiresAt: issued.expiresAt,
      tokenId: issued.id,
    }
    await deliverAuthLink(input)
    await deliverAuthLink(input)

    expect(
      await prisma.notification.count({
        where: { recipientType: 'STAFF', recipientId: user.id },
      }),
    ).toBe(1)
  })

  it('ignores a preference row switching it off', async () => {
    const user = await staffUser()
    await prisma.notificationPreference.create({
      data: {
        recipientType: 'STAFF',
        recipientId: user.id,
        category: 'account_access',
        channel: 'EMAIL',
        enabled: false,
      },
    })

    const issued = await sendOne(user, 'https://example.test/reset-password?token=locked')
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { idempotencyKey: `auth-link:${issued.id}:EMAIL` },
      include: { delivery: { select: { status: true, suppressedReason: true } } },
    })
    // `account_access` is on LOCKED_CATEGORIES: somebody who muted the message
    // that lets them sign in could never sign in to unmute it.
    expect(notification.delivery?.suppressedReason).toBeNull()
    expect(notification.delivery?.status).not.toBe('SUPPRESSED')
  })
})
