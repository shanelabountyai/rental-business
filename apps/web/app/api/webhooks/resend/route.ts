import { mapResendEventStatus, shouldApplyStatus, verifyResendSignature } from '@rental/core/comms'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'

// Resend's delivery webhook (R-054's bounce/failure path).
//
// A PUBLIC, UNAUTHENTICATED ENDPOINT, exactly like /api/sms/status next
// door: Resend holds no credential of ours, so the Svix-signed headers ARE
// the authentication. See webhook-signature.ts for the scheme.
//
// Deliberately NOT wired to a sender yet - provider.ts still wires
// LoggingChannelAdapter (D-15), so nothing posts here in this build. Written
// and tested now for the same reason /api/sms/status was: the alternative
// is discovering the event mapping is wrong on the day real mail starts
// moving, and a hard bounce is the one email outcome this product has to
// act on rather than just log - see flagTenantBounce below.

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    // 503, so Resend retries: a callback lost during a misconfiguration
    // window is a delivery record that stays wrong forever.
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET is not set; refusing callback')
    return new Response('Not configured', { status: 503 })
  }

  // Read as text, not json(): the signature is computed over the exact bytes
  // Resend sent, and re-serializing a parsed object is not guaranteed to
  // reproduce them.
  const rawBody = await request.text()

  if (
    !verifyResendSignature({
      secret,
      svixId: request.headers.get('svix-id'),
      svixTimestamp: request.headers.get('svix-timestamp'),
      signatureHeader: request.headers.get('svix-signature'),
      rawBody,
    })
  ) {
    console.error('[resend-webhook] rejected a callback with an invalid signature')
    return new Response('Forbidden', { status: 403 })
  }

  let payload: { type?: string; data?: { email_id?: string } }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const externalId = payload.data?.email_id ?? ''
  if (!externalId) return new Response('Missing data.email_id', { status: 400 })

  const status = mapResendEventStatus(payload.type ?? '')
  // A delay, a complaint, an open, a click: valid events, nothing this
  // column records. 204, not 400 - Resend sent something real, we simply
  // have nothing to do with it.
  if (status === null) return new Response(null, { status: 204 })

  try {
    // Email goes out on two paths that share deliverOverChannel (see that
    // file's header) but write to different tables - the automated engine's
    // Notification/NotificationDelivery, and a staff thread reply's
    // Message/MessageDelivery. Check both; a given email_id belongs to
    // exactly one.
    const notificationDelivery = await prisma.notificationDelivery.findFirst({
      where: { externalId },
      select: {
        id: true,
        status: true,
        notification: { select: { recipientType: true, recipientId: true, propertyId: true } },
      },
    })

    if (notificationDelivery) {
      if (!shouldApplyStatus(status, notificationDelivery.status)) {
        return new Response(null, { status: 204 })
      }
      await prisma.notificationDelivery.update({
        where: { id: notificationDelivery.id },
        data: {
          status,
          deliveredAt: status === 'DELIVERED' ? new Date() : undefined,
          failedAt: status === 'BOUNCED' ? new Date() : undefined,
          failureCode: status === 'BOUNCED' ? 'resend:bounced' : undefined,
        },
      })
      if (
        status === 'BOUNCED' &&
        notificationDelivery.notification.recipientType === 'TENANT' &&
        notificationDelivery.notification.propertyId
      ) {
        await flagTenantBounce({
          tenantId: notificationDelivery.notification.recipientId,
          propertyId: notificationDelivery.notification.propertyId,
        })
      }
      return new Response(null, { status: 204 })
    }

    const messageDelivery = await prisma.messageDelivery.findFirst({
      where: { externalId },
      select: {
        id: true,
        status: true,
        message: { select: { tenantId: true, thread: { select: { propertyId: true } } } },
      },
    })

    if (!messageDelivery) {
      // The message may predate this route, or belong to another
      // environment sharing the account. Asking Resend to retry would not
      // make the row appear.
      console.info(`[resend-webhook] no delivery for ${externalId} (${payload.type})`)
      return new Response(null, { status: 204 })
    }
    if (!shouldApplyStatus(status, messageDelivery.status)) {
      return new Response(null, { status: 204 })
    }

    await prisma.messageDelivery.update({
      where: { id: messageDelivery.id },
      data: {
        status,
        deliveredAt: status === 'DELIVERED' ? new Date() : undefined,
        failedAt: status === 'BOUNCED' ? new Date() : undefined,
        failureCode: status === 'BOUNCED' ? 'resend:bounced' : undefined,
      },
    })
    if (status === 'BOUNCED' && messageDelivery.message.tenantId) {
      await flagTenantBounce({
        tenantId: messageDelivery.message.tenantId,
        propertyId: messageDelivery.message.thread.propertyId,
      })
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    // 500 makes Resend retry, and every write above is idempotent -
    // `shouldApplyStatus` refuses to reapply a status already recorded.
    console.error('[resend-webhook] failed to record a delivery status', error)
    return new Response('Error', { status: 500 })
  }
}

/**
 * "A hard bounce flags the tenant and creates a Task rather than a private
 * queue table" (D-9, R-054).
 *
 * The Task IS the flag - no new column on Tenant. D-9's schema comment
 * already names "bounced messages" as one of the things meant to be a VIEW
 * over the one queue rather than a fact stored a second way, and a flag no
 * screen reads is exactly the "promise the product does not keep" the task
 * registry's own header warns against.
 *
 * Idempotent per tenant per property-local day via `createTask`'s own
 * (type, subjectId, businessDate) index - several bounced emails to the
 * same dead address in one day raise one task, not one per message.
 */
async function flagTenantBounce(args: { tenantId: string; propertyId: string }): Promise<void> {
  const [tenant, property] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: args.tenantId },
      select: { firstName: true, lastName: true },
    }),
    prisma.property.findUnique({ where: { id: args.propertyId }, select: { timezone: true } }),
  ])
  if (!property) return

  const name = tenant ? `${tenant.firstName} ${tenant.lastName}` : 'a tenant'

  await createTask(prisma, {
    propertyId: args.propertyId,
    type: 'tenant_email_bounced',
    subjectType: 'Tenant',
    subjectId: args.tenantId,
    businessDate: businessDate(new Date(), property.timezone),
    priority: 'ROUTINE',
    title: `Email bounced for ${name} — confirm their address`,
  }).catch((error) => {
    // The delivery row is already written and is the part that must not be
    // lost - same trade raiseBlockedNoticeTask makes in send.ts.
    console.error('[resend-webhook] failed to raise a bounce task', error)
  })
}
