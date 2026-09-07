'use server'

import { createHash } from 'node:crypto'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import {
  type ClarificationArgs,
  applyClarification,
  verifyClarifyLink,
} from './clarify-link.ts'

// The writes behind the zero-login clarify page (R-177).
//
// PHYSICALLY SEPARATE from `maintenance/actions.ts`, and not for tidiness:
// every write in that file opens with `requireTenantWithScope()` or
// `requirePermission()`, and there is no session here BY CONSTRUCTION - the
// whole point of the link is that the tenant with a phone and no email never
// had one. The same split R-032c drew between `verify-link-actions.ts` and
// its staff counterpart, and R-058 drew again between `actions.ts` and
// `staff-actions.ts`: a file mixing a session-less action with one that
// resolves a session through Auth.js fails to import under Vitest for EVERY
// export in it.
//
// EVERY ACTION HERE RE-VERIFIES THE TOKEN. The page rendering a form is not
// authorization for the submit that follows - they are two requests, and only
// the first one was ever checked (D-45).

const MAX_PHOTO_BYTES = 15 * 1024 * 1024

/// The wizard's imperative Submit, bound to one token.
export async function submitClarification(
  token: string,
  args: ClarificationArgs,
): Promise<{ error?: string; fieldErrors?: Record<string, string> } | { ticketId: string }> {
  const result = await applyClarification(token, args)
  if ('error' in result) return result

  // The staff ticket page is a Server Component reading this row; without
  // this it keeps serving the pre-clarification description to whoever is
  // triaging, which is the one reader the answers are FOR.
  revalidatePath(`/maintenance/${result.ticketId}`)
  return { ticketId: result.ticketId }
}

/**
 * The same Submit as a plain `<form action>`, for a tenant with no JavaScript.
 *
 * The wizard's whole reason for living in the URL (R-111): pressing Send
 * before hydration has to be an ordinary navigation rather than a tap that
 * does nothing. This path carries no photos by construction - a file cannot
 * travel in a query string, so a tenant who got here without JavaScript never
 * picked one.
 *
 * On failure it redirects back carrying the same answers and a FLAG, never
 * the message: a URL that renders arbitrary prose inside this product's own
 * chrome is a phishing link somebody can post. The wizard renders its own
 * fixed sentence for `err=1`.
 */
export async function submitClarificationForm(
  token: string,
  formData: FormData,
): Promise<void> {
  const promptAnswers: Record<string, string> = {}
  const troubleshooting: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') continue
    if (key.startsWith('p_')) promptAnswers[key.slice(2)] = value
    else if (key.startsWith('t_')) troubleshooting[key.slice(2)] = value
  }
  const tri = (name: string): boolean | undefined => {
    const value = formData.get(name)
    return value === null ? undefined : value === 'yes'
  }

  const result = await submitClarification(token, {
    category: String(formData.get('category') ?? ''),
    promptAnswers,
    troubleshooting,
    entryPermission: tri('entry'),
    petWarning: tri('pet'),
    petNote: String(formData.get('petNote') ?? ''),
    photoDocumentIds: [],
  })

  // Back to the same page either way. On success the token is burned, so the
  // page renders its own "thanks, we have your answers" branch - which is
  // also what somebody reopening the link tomorrow sees, and is right for
  // both readers.
  if ('ticketId' in result) redirect(`/clarify/${token}`)

  const params = new URLSearchParams()
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$')) params.set(key, value)
  }
  params.set('step', 'review')
  params.set('err', '1')
  redirect(`/clarify/${token}?${params}`)
}

/**
 * One photo, uploaded before the answers are sent - the token's twin of
 * `uploadMaintenancePhoto`.
 *
 * The Document is created as an ORPHAN (`ticketId` null) and
 * `applyClarification` attaches whatever has finished by the time Send
 * resolves, exactly as the portal wizard's own pair does. Property, unit and
 * tenant come from the TICKET THE TOKEN NAMES, never from anything the
 * browser sent - which is what makes an orphan document safe to create for a
 * caller with no session.
 */
export async function uploadClarificationPhoto(
  token: string,
  file: File,
): Promise<{ id: string } | { error: string }> {
  const link = await verifyClarifyLink(token)
  if (!link.ok) return { error: 'This link is no longer accepting photos.' }

  if (!file.type.startsWith('image/')) {
    return { error: 'Only photos can be attached here.' }
  }
  if (file.size === 0 || file.size > MAX_PHOTO_BYTES) {
    return { error: 'Choose a photo under 15MB.' }
  }

  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { id: link.ticketId },
    select: { propertyId: true, unitId: true, tenantId: true },
  })

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const storageKey = generateStorageKey(ticket.propertyId, file.name)
  await storage.put(storageKey, buffer, file.type)

  const created = await prisma.document.create({
    data: {
      propertyId: ticket.propertyId,
      unitId: ticket.unitId,
      tenantId: ticket.tenantId,
      type: 'MAINTENANCE_PHOTO',
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      storageKey,
      sha256,
    },
  })

  return { id: created.id }
}
