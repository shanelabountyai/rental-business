'use server'

import { randomBytes } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { authUrl, deliverAuthLink } from '@/lib/auth/delivery.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { grantAssignment, revokeAssignment } from '@/lib/staff/assignments.ts'
import { allAssignmentSummaries } from '@/lib/staff/queries.ts'
import { deactivationRefusal, isStaffRoleKey, revokeRefusal } from '@/lib/staff/rules.ts'

// The screen R-004's `assignments.ts` said R-007 would build, and R-007 did
// not (R-138). Everything here routes through `grantAssignment` /
// `revokeAssignment` rather than writing StaffAssignment rows, because those
// two put the grant and its audit entry in ONE transaction and a hand-rolled
// write here would not.
//
// `staff.manage` is on PRIVILEGED_PERMISSIONS, so every mutation below is
// MFA-gated by `requirePermission` before it does anything - handing somebody
// the keys is the action ROLE-05 most wants a second factor in front of.

export interface StaffFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  /// The invite's setup link, shown to the granting owner (see `inviteStaff`).
  setupUrl?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// A scope select posts `property:<id>`, `entity:<id>` or `all`. One field
/// rather than two, because "a property AND an entity" is not a scope this
/// product has and two selects would let somebody express it.
function parseScope(raw: string): { propertyId?: string; legalEntityId?: string } | null {
  if (raw === 'all') return {}
  const [kind, id] = raw.split(':')
  if (kind === 'property' && id) return { propertyId: id }
  if (kind === 'entity' && id) return { legalEntityId: id }
  return null
}

/**
 * Creates a staff member, grants their first role, and sends a setup link.
 *
 * THE LINK IS ALSO SHOWN TO THE GRANTING OWNER, deliberately, exactly as
 * `db:create-owner` prints it to a terminal. `deliverAuthLink` still drops
 * every auth link in production with a console warning - R-003's seam that
 * R-104 never rewired - so a delivered-only invite would be a feature that
 * cannot work where it matters. Showing it is not an escalation: the actor
 * created this account seconds ago and holds `staff.manage`, so they could
 * mint another link at will. Filed separately; see PROGRESS.
 */
export async function inviteStaff(
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  await requirePermission('staff.manage')

  const email = str(formData, 'email').toLowerCase()
  const name = str(formData, 'name')
  const roleKey = str(formData, 'roleKey')
  const scopeRaw = str(formData, 'scope')

  const fieldErrors: Record<string, string> = {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fieldErrors.email = 'That does not look like an email address.'
  }
  if (name.length === 0) fieldErrors.name = 'A name is required.'
  if (!isStaffRoleKey(roleKey)) {
    fieldErrors.roleKey = 'Pick one of the four staff roles.'
  }
  const scope = parseScope(scopeRaw)
  if (scope === null) fieldErrors.scope = 'Pick a scope.'
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  if (await prisma.staffUser.findUnique({ where: { email }, select: { id: true } })) {
    return {
      error: `${email} already has an account. Grant them another role from their own page instead of making a second one.`,
      fieldErrors: { email: 'Already in use.' },
    }
  }

  // A random password nobody holds, so the account is never in a "no
  // credential" state and the ordinary reset flow works unchanged. Same
  // posture as `db:create-owner`; it is never printed.
  const unusable = randomBytes(32).toString('base64url')
  const created = await prisma.staffUser.create({
    data: {
      email,
      name,
      credential: { create: { passwordHash: await hashPassword(unusable) } },
    },
  })

  // Outside the create: `grantAssignment` opens its own transaction with the
  // audit entry in it, which is the ordering that keeps the log honest.
  await grantAssignment(created.id, roleKey, scope ?? {})

  const issued = await issueToken('STAFF_PASSWORD_RESET', {
    type: 'StaffUser',
    id: created.id,
  })
  const url = authUrl(`/reset-password?token=${issued.token}`)
  await deliverAuthLink({
    // A SETUP link, not a reset: nobody asked for this one, so "ignore it if
    // you did not request it" would be exactly the wrong advice.
    kind: 'staff_setup_link',
    recipient: { type: 'STAFF', id: created.id, name },
    to: email,
    url,
    expiresAt: issued.expiresAt,
    tokenId: issued.id,
  })

  revalidatePath('/staff')
  return {
    notice: `${name} can now sign in as soon as they set a password. The link below expires in about ${Math.max(1, Math.round((issued.expiresAt.getTime() - Date.now()) / 60_000))} minutes.`,
    setupUrl: url,
  }
}

/**
 * Every mutation on one staff member's page, dispatched on `intent`.
 *
 * ONE action so the page can hold ONE `useActionState` and mount ONE result
 * region above every panel. Each control here can change whether its own
 * panel renders - revoking the last grant empties the list, deactivating
 * swaps the button - and a result region inside a panel the action unmounts
 * announces nothing at all, which is the trap CLAUDE.md names.
 */
export async function manageStaff(
  staffUserId: string,
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const actor = await requirePermission('staff.manage')
  const intent = str(formData, 'intent')

  const target = await prisma.staffUser.findUnique({
    where: { id: staffUserId },
    select: { id: true, name: true, email: true, active: true },
  })
  if (!target) return { error: 'That staff member no longer exists.' }

  const done = (notice: string): StaffFormState => {
    revalidatePath('/staff')
    revalidatePath(`/staff/${staffUserId}`)
    return { notice }
  }

  if (intent === 'grant') {
    const roleKey = str(formData, 'roleKey')
    const scope = parseScope(str(formData, 'scope'))
    if (!isStaffRoleKey(roleKey)) {
      return { error: 'Pick one of the four staff roles.', fieldErrors: { roleKey: 'Required.' } }
    }
    if (scope === null) {
      return { error: 'Pick a scope.', fieldErrors: { scope: 'Required.' } }
    }
    await grantAssignment(staffUserId, roleKey, scope)
    return done(`Granted ${roleKey.replace('_', ' ')} to ${target.name}.`)
  }

  if (intent === 'revoke') {
    const assignmentId = str(formData, 'assignmentId')
    const refusal = revokeRefusal(assignmentId, await allAssignmentSummaries())
    if (refusal) return { error: refusal }
    await revokeAssignment(assignmentId, str(formData, 'reason') || undefined)
    return done(`Revoked. ${target.name} loses that access on their next request.`)
  }

  if (intent === 'deactivate') {
    const refusal = deactivationRefusal(staffUserId, actor.id, await allAssignmentSummaries())
    if (refusal) return { error: refusal }

    const now = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.staffUser.update({
        where: { id: staffUserId },
        // ROLE-06: history is preserved and access stops. The watermark is
        // what makes the second half true within a minute - Auth.js sessions
        // are JWTs and cannot be deleted server-side, and `auth.ts` caches the
        // (active, sessionsValidFrom) pair for ~30 seconds.
        data: { active: false, deactivatedAt: now, sessionsValidFrom: now },
      })
      // Assignments are deliberately left standing. Reactivation should
      // restore what they had rather than silently returning a leaver with no
      // access at all, and `active: false` already refuses every request.
      await audit(
        {
          action: 'staff.deactivated',
          entityType: 'StaffUser',
          entityId: staffUserId,
          before: { active: true },
          after: { active: false, deactivatedAt: now, sessionsRevoked: true },
          reason: str(formData, 'reason') || undefined,
        },
        tx,
      )
    })
    return done(`${target.name} is deactivated. Their sessions end within a minute.`)
  }

  if (intent === 'reactivate') {
    await prisma.$transaction(async (tx) => {
      await tx.staffUser.update({
        where: { id: staffUserId },
        data: { active: true, deactivatedAt: null },
      })
      await audit(
        {
          action: 'staff.reactivated',
          entityType: 'StaffUser',
          entityId: staffUserId,
          before: { active: false },
          after: { active: true },
        },
        tx,
      )
    })
    return done(`${target.name} is active again, with the assignments they held before.`)
  }

  if (intent === 'resend') {
    if (!target.active) {
      return { error: 'Reactivate this account before sending a sign-in link to it.' }
    }
    const issued = await issueToken('STAFF_PASSWORD_RESET', {
      type: 'StaffUser',
      id: staffUserId,
    })
    const url = authUrl(`/reset-password?token=${issued.token}`)
    await deliverAuthLink({
      kind: 'staff_setup_link',
      recipient: { type: 'STAFF', id: staffUserId, name: target.name },
      to: target.email,
      url,
      expiresAt: issued.expiresAt,
      tokenId: issued.id,
    })
    await audit({
      action: 'staff.setup_link_reissued',
      entityType: 'StaffUser',
      entityId: staffUserId,
      after: { to: target.email, expiresAt: issued.expiresAt },
    })
    return { notice: `A new setup link for ${target.name} is below.`, setupUrl: url }
  }

  if (intent === 'ceilings') {
    const parse = (field: string): number | null | undefined => {
      const raw = str(formData, field)
      if (raw === '') return null
      const dollars = Number(raw)
      if (!Number.isFinite(dollars) || dollars < 0) return undefined
      return Math.round(dollars * 100)
    }
    const approve = parse('approveWorkOrderDollars')
    const waive = parse('waiveFeeDollars')
    if (approve === undefined || waive === undefined) {
      return { error: 'Ceilings must be blank or a positive amount.' }
    }

    await prisma.$transaction(async (tx) => {
      await tx.staffUser.update({
        where: { id: staffUserId },
        // Blank means null, which is "fall back to the role default" - NOT
        // zero, which is the real and different value "may approve nothing"
        // (the schema comment's own warning, and why the fallback is on null
        // rather than on falsiness).
        data: { approveWorkOrderCents: approve, waiveFeeCents: waive },
      })
      await audit(
        {
          action: 'staff.ceiling_changed',
          entityType: 'StaffUser',
          entityId: staffUserId,
          after: { approveWorkOrderCents: approve, waiveFeeCents: waive },
        },
        tx,
      )
    })
    return done(`Updated the approval ceilings for ${target.name}.`)
  }

  return { error: 'Unrecognised action.' }
}
