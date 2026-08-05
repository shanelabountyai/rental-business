'use server'

import {
  type OutboundChannel,
  validateCallLog,
  validateOutboundMessage,
} from '@rental/core/comms'
import { wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { logCall, routeUnroutedMessage, sendThreadMessage } from './messages.ts'
import { propertyForTenant, resolveThread } from './threads.ts'

// Writes for comms threading (COMM-01, R-017). Same shape as every other
// lib/*/actions.ts: a resource-carrying permission check first.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The thread, plus the permission check for acting in it.
 *
 * The thread is loaded by id and the check runs against ITS OWN property as
 * the resource - the same shape every other actions.ts in this repo uses. A
 * thread id copied from somewhere it should not have been is refused by
 * `requirePermission`, because a property-scoped manager's grant only matches
 * when the resource names a property they actually hold (R-004's `can()`).
 * The id itself is not the authorization.
 */
async function threadForWrite(threadId: string) {
  const thread = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    include: {
      // timezone too: a logged call's wall-clock time is property-local, and
      // resolving it in any other zone misdates the evidence (D-3).
      property: { select: { id: true, legalEntityId: true, timezone: true } },
      tenant: { select: { email: true, phone: true } },
      vendor: { select: { email: true, phone: true } },
    },
  })
  const actor = await requirePermission(
    'message.send',
    propertyResource(thread.property),
  )
  return { thread, actor }
}

export async function replyInThread(
  threadId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { thread, actor } = await threadForWrite(threadId)

  const channel = str(formData, 'channel')
  const body = str(formData, 'body')

  const violations = validateOutboundMessage({ threadId, channel, body })
  if (violations.length > 0) return violationsToState(violations)

  const party = thread.tenant ?? thread.vendor
  const toAddress =
    channel === 'SMS'
      ? (party?.phone ?? null)
      : channel === 'EMAIL'
        ? (party?.email ?? null)
        : null

  if (channel !== 'PORTAL' && !toAddress) {
    return {
      error: `No ${channel === 'SMS' ? 'phone number' : 'email address'} on file for this conversation.`,
    }
  }

  await sendThreadMessage({
    threadId,
    channel: channel as OutboundChannel,
    body,
    staffUserId: actor.id,
    toAddress,
  })

  revalidatePath(`/messages/${threadId}`)
  redirect(`/messages/${threadId}`)
}

export async function logCallInThread(
  threadId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { thread, actor } = await threadForWrite(threadId)

  const body = str(formData, 'body')
  const submitted = str(formData, 'occurredAt')

  // The form field carries no timezone. It is read in the PROPERTY's zone and
  // converted to UTC here, at the boundary - never parsed as a bare string,
  // which would silently mean "whatever zone this server runs in".
  let occurredAt: Date | null = null
  if (submitted) {
    try {
      occurredAt = wallClockToUtc(submitted, thread.property.timezone)
    } catch {
      occurredAt = null
    }
  }

  const violations = validateCallLog({ threadId, body, occurredAt })
  if (violations.length > 0) return violationsToState(violations)

  await logCall({
    threadId,
    body,
    staffUserId: actor.id,
    occurredAt: occurredAt!,
  })

  revalidatePath(`/messages/${threadId}`)
  redirect(`/messages/${threadId}`)
}

/**
 * Files an unrouted inbound message into a tenant's thread.
 *
 * The tenant is chosen by a human, which is the entire point: the engine
 * refused to guess (see `decideRoute`), so this is where a person takes
 * responsibility for the association. The permission check runs against the
 * TARGET thread's property, so somebody cannot file a stray text into a
 * property they have no access to.
 */
export async function fileUnroutedMessage(
  unroutedId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const tenantId = str(formData, 'tenantId')
  if (!tenantId) {
    return { error: 'Choose who this message is from.' }
  }

  const propertyId = await propertyForTenant(tenantId)
  if (!propertyId) {
    return {
      error: 'That tenant has no lease on file, so there is no property to file this under.',
    }
  }

  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { id: true, legalEntityId: true },
  })
  const actor = await requirePermission(
    'message.send',
    propertyResource(property),
  )

  const thread = await resolveThread({
    scope: 'TENANT',
    propertyId,
    tenantId,
  })

  try {
    await routeUnroutedMessage({
      unroutedId,
      threadId: thread.id,
      staffUserId: actor.id,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'ALREADY_ROUTED') {
      // Two people triaging the same item. Not an error worth showing as one.
      redirect(`/messages/${thread.id}`)
    }
    throw error
  }

  revalidatePath('/messages')
  redirect(`/messages/${thread.id}`)
}
