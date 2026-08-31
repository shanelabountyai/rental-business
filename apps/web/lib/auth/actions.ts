'use server'

import {
  RATE_LIMITS,
  createTotpEnrolment,
  hashPassword,
  isLockedOut,
  lockoutUntil,
  mintRecoveryCodes,
  openSecret,
  sealSecret,
  validatePassword,
  verifyPassword,
  verifyTotp,
} from '@rental/core/auth'
import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth, signIn, signOut } from '@/auth.ts'
import { currentAuditActor } from '@/lib/audit/index.ts'
import { authUrl, deliverAuthLink } from './delivery.ts'
import { consumeRateLimit, issueToken, redeemToken, revokeTokens } from './store.ts'

// Every flow in this file follows two rules.
//
// 1. NO USER ENUMERATION. "That email has no account", "wrong password" and
//    "your account is locked" all look identical from outside. An attacker who
//    can tell a registered address from an unregistered one has a tenant list,
//    and for a rental business a tenant list is a target list.
//
// 2. Rate limit BEFORE doing work. The limiter runs before the password hash,
//    not after, or the expensive operation is itself the denial of service.

const CHALLENGE_COOKIE = 'rental_mfa_challenge'

export interface FormState {
  error?: string
  notice?: string
}

/// One message for every failure mode of sign-in. See rule 1.
const GENERIC_SIGN_IN_ERROR =
  'Those details did not match an account. Check them and try again.'
const GENERIC_RATE_LIMIT_ERROR =
  'Too many attempts. Wait a few minutes and try again.'

/**
 * Auth.js reports BOTH outcomes of signIn() by throwing: a success throws
 * Next's redirect, and a rejected credential throws AuthError. Letting either
 * escape a server action is wrong in a different way - the redirect must
 * propagate to work at all, and the AuthError would replace the sign-in form
 * with an error page instead of a message the user can act on.
 *
 * So: re-throw redirects, convert everything else into form state.
 */
async function signInOrFormError(
  provider: string,
  options: Record<string, unknown>,
): Promise<FormState> {
  try {
    await signIn(provider, options)
    return {}
  } catch (error) {
    if (isRedirectError(error)) throw error
    return { error: GENERIC_SIGN_IN_ERROR }
  }
}

function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  )
}

async function clientIp(): Promise<string> {
  const headerList = await headers()
  // Vercel sets x-forwarded-for; the leftmost entry is the client. Trusted
  // only because Vercel's proxy rewrites it - never trust this behind an
  // arbitrary reverse proxy.
  const forwarded = headerList.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Staff sign-in
// ---------------------------------------------------------------------------

export async function startStaffSignIn(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: GENERIC_SIGN_IN_ERROR }

  const ip = await clientIp()
  const limit = await consumeRateLimit(`login:staff:${ip}`, RATE_LIMITS.login)
  if (!limit.allowed) return { error: GENERIC_RATE_LIMIT_ERROR }

  const staffUser = await prisma.staffUser.findUnique({
    where: { email },
    include: { credential: true },
  })

  // Deliberately uniform: no account, no credential, inactive account and
  // locked account all fall through to the same failure as a wrong password.
  if (!staffUser?.active || !staffUser.credential) {
    return { error: GENERIC_SIGN_IN_ERROR }
  }
  if (isLockedOut(staffUser.credential.lockedUntil)) {
    return { error: GENERIC_SIGN_IN_ERROR }
  }

  const correct = await verifyPassword(password, staffUser.credential.passwordHash)
  if (!correct) {
    const failedLoginCount = staffUser.credential.failedLoginCount + 1
    const lockedUntil = lockoutUntil(failedLoginCount)
    await prisma.staffCredential.update({
      where: { id: staffUser.credential.id },
      data: { failedLoginCount, lockedUntil },
    })
    // Individual wrong guesses are NOT audited: the rate limiter already caps
    // them, and an attacker would otherwise be able to fill the audit table -
    // which is append-only and cannot be pruned. Crossing into lockout is a
    // real security event and is recorded once.
    if (lockedUntil && !staffUser.credential.lockedUntil) {
      await recordAudit(prisma, {
        actor: { type: 'SYSTEM', ref: 'auth.lockout', ipAddress: ip },
        action: 'auth.locked_out',
        entityType: 'StaffUser',
        entityId: staffUser.id,
        after: { failedLoginCount, lockedUntil },
      })
    }
    return { error: GENERIC_SIGN_IN_ERROR }
  }

  // Password proved. Hand out a single-use challenge and finish in the
  // provider, so the second factor never carries the password again.
  const challenge = await issueToken(
    'STAFF_MFA_CHALLENGE',
    { type: 'StaffUser', id: staffUser.id },
    { requestedIp: ip },
  )
  const cookieStore = await cookies()
  cookieStore.set(CHALLENGE_COOKIE, challenge.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: challenge.expiresAt,
    path: '/',
  })

  if (staffUser.credential.mfaEnrolledAt) {
    redirect('/login/mfa')
  }

  return signInOrFormError('staff-challenge', {
    challengeToken: challenge.token,
    redirectTo: '/dashboard',
  })
}

export async function completeStaffMfa(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = String(formData.get('code') ?? '').trim()
  const cookieStore = await cookies()
  const challengeToken = cookieStore.get(CHALLENGE_COOKIE)?.value
  if (!challengeToken) {
    return { error: 'That sign-in attempt expired. Start again.' }
  }

  // Keyed on the challenge, not the IP: a six-digit code is only a million
  // wide, and this is the window in which an attacker already holds a valid
  // password.
  const limit = await consumeRateLimit(
    `mfa:${challengeToken.slice(0, 16)}`,
    RATE_LIMITS.mfaVerify,
  )
  if (!limit.allowed) return { error: GENERIC_RATE_LIMIT_ERROR }

  const result = await signInOrFormError('staff-challenge', {
    challengeToken,
    code,
    redirectTo: '/dashboard',
  })
  // The challenge survives a wrong code on purpose - it is burned only after
  // the factor verifies - so the message says "try again", not "start over".
  return result.error
    ? { error: 'That code was not right. Check your authenticator app.' }
    : result
}

export async function signOutEverywhere(): Promise<void> {
  const session = await auth()
  if (session?.principal) {
    const actor = await currentAuditActor()
    await recordAudit(prisma, {
      actor,
      action: 'auth.sessions_revoked',
      entityType: session.principal.kind === 'staff' ? 'StaffUser' : 'Tenant',
      entityId: session.principal.id,
      after: { allDevices: true },
    })
    // Bumping the watermark kills every other device too, which is the point:
    // "sign out" after a lost laptop has to mean everywhere.
    const now = new Date()
    if (session.principal.kind === 'staff') {
      await prisma.staffUser.update({
        where: { id: session.principal.id },
        data: { sessionsValidFrom: now },
      })
    } else {
      await prisma.tenant.update({
        where: { id: session.principal.id },
        data: { sessionsValidFrom: now },
      })
    }
  }
  await signOut({ redirectTo: '/login' })
}

// ---------------------------------------------------------------------------
// MFA enrolment
// ---------------------------------------------------------------------------

export async function beginMfaEnrolment(): Promise<
  FormState & { secret?: string; uri?: string }
> {
  const session = await auth()
  if (session?.principal.kind !== 'staff') {
    return { error: 'Sign in first.' }
  }

  const enrolment = createTotpEnrolment(session.principal.email ?? 'staff')
  // Stored sealed but NOT marked enrolled: possessing a secret is not proof
  // the user's authenticator has it. mfaEnrolledAt is set only after a correct
  // code, so a half-finished enrolment cannot lock anyone out.
  await prisma.staffCredential.update({
    where: { staffUserId: session.principal.id },
    data: { mfaSecret: sealSecret(enrolment.secret), mfaEnrolledAt: null },
  })

  return { secret: enrolment.secret, uri: enrolment.uri }
}

export async function confirmMfaEnrolment(
  _previous: FormState & { recoveryCodes?: string[] },
  formData: FormData,
): Promise<FormState & { recoveryCodes?: string[] }> {
  const session = await auth()
  if (session?.principal.kind !== 'staff') return { error: 'Sign in first.' }

  const code = String(formData.get('code') ?? '').trim()
  const credential = await prisma.staffCredential.findUnique({
    where: { staffUserId: session.principal.id },
  })
  if (!credential?.mfaSecret) {
    return { error: 'Start enrolment again — no pending setup was found.' }
  }

  const secret = openSecret(credential.mfaSecret)
  if (!secret || !verifyTotp(secret, code)) {
    return { error: 'That code was not right. Check your authenticator app.' }
  }

  const recovery = mintRecoveryCodes()
  const actor = await currentAuditActor()
  await prisma.$transaction(async (tx) => {
    await tx.staffCredential.update({
      where: { id: credential.id },
      data: { mfaEnrolledAt: new Date(), mfaRecoveryCodes: recovery.hashes },
    })
    // The payload deliberately carries no secret and no codes - redaction
    // would strip them anyway, and the auditable fact is "this account gained
    // a second factor at this moment", not what the factor is.
    await recordAudit(tx, {
      actor,
      action: 'auth.mfa_enrolled',
      entityType: 'StaffUser',
      entityId: session.principal.id,
      after: { mfaEnrolled: true, recoveryCodesIssued: recovery.codes.length },
    })
  })

  // Returned once and never again - only hashes were stored.
  return {
    notice: 'Two-factor authentication is on. Save these recovery codes now.',
    recoveryCodes: recovery.codes,
  }
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

const RESET_SENT_NOTICE =
  'If that address has an account, a reset link is on its way. It expires in 30 minutes.'

export async function requestPasswordReset(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  const ip = await clientIp()
  const limit = await consumeRateLimit(
    `reset:${ip}`,
    RATE_LIMITS.passwordResetRequest,
  )
  // Even the rate-limit response is the neutral one: a distinguishable "too
  // many requests" would confirm which addresses are worth retrying.
  if (!limit.allowed) return { notice: RESET_SENT_NOTICE }

  const staffUser = await prisma.staffUser.findUnique({ where: { email } })
  if (staffUser?.active) {
    const issued = await issueToken(
      'STAFF_PASSWORD_RESET',
      { type: 'StaffUser', id: staffUser.id },
      { requestedIp: ip },
    )
    await deliverAuthLink({
      kind: 'staff_password_reset',
      recipient: { type: 'STAFF', id: staffUser.id, name: staffUser.name },
      to: staffUser.email,
      url: authUrl(`/reset-password?token=${issued.token}`),
      expiresAt: issued.expiresAt,
      tokenId: issued.id,
    })
  }

  return { notice: RESET_SENT_NOTICE }
}

export async function completePasswordReset(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = String(formData.get('token') ?? '')
  const password = String(formData.get('password') ?? '')
  const confirmation = String(formData.get('confirmPassword') ?? '')
  const ip = await clientIp()

  if (password !== confirmation) {
    return { error: 'Those two passwords do not match.' }
  }
  const violations = validatePassword(password)
  if (violations.length > 0) {
    return { error: violations.map((v) => v.message).join(' ') }
  }

  const redeemed = await redeemToken(token, {
    purpose: 'STAFF_PASSWORD_RESET',
    subjectType: 'StaffUser',
  })
  if (!redeemed.ok) {
    return {
      error: 'That reset link is no longer valid. Request a new one.',
    }
  }

  const passwordHash = await hashPassword(password)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.staffCredential.update({
      where: { staffUserId: redeemed.subjectId },
      data: {
        passwordHash,
        passwordUpdatedAt: now,
        // A reset is how someone locked out gets back in, so it clears the
        // lock. It also has to clear the counter, or they would be one wrong
        // attempt from being locked out again.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    })
    // Every existing session dies. A password reset that leaves the attacker's
    // session alive has not actually reset anything.
    await tx.staffUser.update({
      where: { id: redeemed.subjectId },
      data: { sessionsValidFrom: now },
    })
    // Whoever is holding the reset link is not signed in, so the actor is the
    // reset flow rather than a person - the link itself is the authorisation,
    // and the IP is the only identifying detail there is.
    await recordAudit(tx, {
      actor: { type: 'SYSTEM', ref: 'auth.password_reset', ipAddress: ip },
      action: 'auth.password_reset',
      entityType: 'StaffUser',
      entityId: redeemed.subjectId,
      after: { passwordChangedAt: now, sessionsRevoked: true },
    })
  })

  // Any other reset link sitting in an inbox is now dead too.
  await revokeTokens('STAFF_PASSWORD_RESET', redeemed.subjectId, now)

  redirect('/login?reset=1')
}

// ---------------------------------------------------------------------------
// Tenant magic link
// ---------------------------------------------------------------------------

const MAGIC_LINK_NOTICE =
  'If that address is on a lease, a sign-in link is on its way. It expires in 15 minutes.'

export async function requestTenantMagicLink(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  const ip = await clientIp()
  const limit = await consumeRateLimit(
    `magiclink:${ip}`,
    RATE_LIMITS.magicLinkRequest,
  )
  if (!limit.allowed) return { notice: MAGIC_LINK_NOTICE }

  const tenant = await prisma.tenant.findFirst({
    where: { email, active: true },
  })
  if (tenant?.email) {
    const issued = await issueToken(
      'TENANT_MAGIC_LINK',
      { type: 'Tenant', id: tenant.id },
      { requestedIp: ip },
    )
    await deliverAuthLink({
      kind: 'tenant_magic_link',
      recipient: { type: 'TENANT', id: tenant.id, name: tenant.firstName },
      to: tenant.email,
      url: authUrl(`/portal/verify?token=${issued.token}`),
      expiresAt: issued.expiresAt,
      tokenId: issued.id,
    })
  }

  return { notice: MAGIC_LINK_NOTICE }
}
