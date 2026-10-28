'use server'

import {
  RATE_LIMITS,
  createTotpEnrolment,
  hashPassword,
  isLockedOut,
  lockoutUntil,
  mintRecoveryCodes,
  needsRehash,
  openSecret,
  sealSecret,
  validatePassword,
  verifyPassword,
  verifyTotp,
} from '@rental/core/auth'
import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { cookies, headers } from 'next/headers'
import { redirect, unstable_rethrow } from 'next/navigation'
import { MfaRateLimited } from '@/auth.ts'
import {
  PLATFORM_MFA_PURPOSE,
  peekPlatformChallenge,
  platformSignIn,
  platformSignOut,
} from '@/platform-auth.ts'
import { isPlatformHost } from '@/lib/auth/platform-host.ts'
import { consumeRateLimit, issueToken, redeemToken } from '@/lib/auth/store.ts'

// Platform console sign-in (PRD 11 §2.3-2.5, R-294b). The staff flow in
// lib/auth/actions.ts is the template, with three differences:
//
// 1. A CODE IS ALWAYS REQUIRED (PADM-02). An admin who has not enrolled is
//    sent from the password straight to enrolment, still holding only the
//    challenge - there is no session until a code is proved, so no page but
//    enrolment is reachable without one.
// 2. Every action refuses off PLATFORM_HOST, and every rate-limit key is
//    `login:platform:`, so an org's shared office IP cannot spend the
//    console's budget or the reverse (§2.5).
// 3. Every audit row is org-less and PLATFORM: these are acts about the
//    platform, and the CHECK refuses an org-less row from any other actor.

export interface FormState {
  error?: string
  notice?: string
}

const CHALLENGE_COOKIE = '__Host-platform.mfa-challenge'
const GENERIC_SIGN_IN_ERROR = 'Those details did not match an account. Check them and try again.'
const GENERIC_RATE_LIMIT_ERROR = 'Too many attempts. Wait a few minutes and try again.'
const EXPIRED = 'That sign-in attempt expired. Start again.'

async function onPlatformHost(): Promise<boolean> {
  return isPlatformHost((await headers()).get('host'))
}

async function clientIp(): Promise<string> {
  // Vercel's proxy rewrites x-forwarded-for; see lib/auth/actions.ts.
  return (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

async function challengeFromCookie(): Promise<{ token: string; adminId: string } | null> {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value
  const adminId = token ? await peekPlatformChallenge(token) : null
  return token && adminId ? { token, adminId } : null
}

/// Auth.js reports success by throwing Next's redirect; that must propagate.
/// Anything else becomes a sentence on the form.
async function finishSignIn(options: Record<string, unknown>): Promise<FormState> {
  try {
    await platformSignIn('platform-challenge', options)
    return {}
  } catch (error) {
    unstable_rethrow(error)
    if (error instanceof MfaRateLimited) return { error: GENERIC_RATE_LIMIT_ERROR }
    return { error: 'That code was not right. Check your authenticator app.' }
  }
}

export async function startPlatformSignIn(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  if (!email || !password || !(await onPlatformHost())) return { error: GENERIC_SIGN_IN_ERROR }

  const ip = await clientIp()
  const limit = await consumeRateLimit(`login:platform:${ip}`, RATE_LIMITS.platformLogin)
  if (!limit.allowed) return { error: GENERIC_RATE_LIMIT_ERROR }

  const admin = await prisma.platformAdmin.findUnique({
    where: { email },
    include: { credential: true },
  })
  const credential = admin?.credential
  // No account, deactivated and locked all read as a wrong password.
  if (!admin?.active || !credential || isLockedOut(credential.lockedUntil)) {
    return { error: GENERIC_SIGN_IN_ERROR }
  }

  if (!(await verifyPassword(password, credential.passwordHash))) {
    const failedLoginCount = credential.failedLoginCount + 1
    const lockedUntil = lockoutUntil(failedLoginCount)
    await prisma.platformCredential.update({
      where: { id: credential.id },
      data: { failedLoginCount, lockedUntil },
    })
    // Crossing into lockout is recorded once, as staff's is. The notice to the
    // other platform owners (§2.5) needs R-302's roles to know who they are.
    if (lockedUntil && !credential.lockedUntil) {
      await recordAudit(prisma, {
        actor: { type: 'PLATFORM', ref: admin.id, ipAddress: ip },
        action: 'auth.locked_out',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
        orgId: null,
        after: { failedLoginCount, lockedUntil },
      })
    }
    return { error: GENERIC_SIGN_IN_ERROR }
  }

  if (needsRehash(credential.passwordHash)) {
    await prisma.platformCredential
      .update({ where: { id: credential.id }, data: { passwordHash: await hashPassword(password) } })
      .catch((error) => console.error(`[platform-auth] rehash failed for ${admin.id}`, error))
  }

  const challenge = await issueToken(
    'PLATFORM_MFA_CHALLENGE',
    { type: 'PlatformAdmin', id: admin.id },
    { requestedIp: ip },
  )
  ;(await cookies()).set(CHALLENGE_COOKIE, challenge.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    expires: challenge.expiresAt,
    path: '/',
  })
  redirect(credential.mfaEnrolledAt ? '/platform/login/mfa' : '/platform/enrol-mfa')
}

export async function completePlatformMfa(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = String(formData.get('code') ?? '').trim()
  const challenge = await challengeFromCookie()
  if (!challenge || !(await onPlatformHost())) return { error: EXPIRED }
  // The challenge survives a wrong code; the provider burns it only on success.
  return finishSignIn({ challengeToken: challenge.token, code, redirectTo: '/platform' })
}

// ---------------------------------------------------------------------------
// Enrolment, on the challenge (PADM-02)
// ---------------------------------------------------------------------------

export async function beginPlatformMfaEnrolment(): Promise<FormState & { secret?: string; uri?: string }> {
  const challenge = await challengeFromCookie()
  if (!challenge || !(await onPlatformHost())) return { error: EXPIRED }
  const admin = await prisma.platformAdmin.findUnique({
    where: { id: challenge.adminId },
    include: { credential: true },
  })
  // Enrolling over an existing factor would let a stolen password replace the
  // device. That is a reset, and resets are another owner's act (PADM-03).
  if (!admin?.active || !admin.credential || admin.credential.mfaEnrolledAt) {
    return { error: EXPIRED }
  }
  const enrolment = createTotpEnrolment(admin.email)
  await prisma.platformCredential.update({
    where: { id: admin.credential.id },
    data: { mfaSecret: sealSecret(enrolment.secret, PLATFORM_MFA_PURPOSE) },
  })
  return { secret: enrolment.secret, uri: enrolment.uri }
}

export async function confirmPlatformMfaEnrolment(
  _previous: FormState & { recoveryCodes?: string[] },
  formData: FormData,
): Promise<FormState & { recoveryCodes?: string[] }> {
  const code = String(formData.get('code') ?? '').trim()
  const challenge = await challengeFromCookie()
  if (!challenge || !(await onPlatformHost())) return { error: EXPIRED }
  const credential = await prisma.platformCredential.findUnique({
    where: { platformAdminId: challenge.adminId },
  })
  if (!credential?.mfaSecret || credential.mfaEnrolledAt) {
    return { error: 'Start enrolment again — no pending setup was found.' }
  }
  // A guess here costs nothing an attacker could use - they would need the
  // secret this same flow just showed them - but a typo-loop is still capped.
  const limit = await consumeRateLimit(
    `mfa:platform:${challenge.token.slice(0, 16)}`,
    RATE_LIMITS.mfaVerify,
  )
  if (!limit.allowed) return { error: GENERIC_RATE_LIMIT_ERROR }
  const secret = openSecret(credential.mfaSecret, PLATFORM_MFA_PURPOSE)
  if (!secret || !verifyTotp(secret, code)) {
    return { error: 'That code was not right. Check your authenticator app.' }
  }

  const recovery = mintRecoveryCodes()
  await prisma.$transaction(async (tx) => {
    await tx.platformCredential.update({
      where: { id: credential.id },
      data: { mfaEnrolledAt: new Date(), mfaRecoveryCodes: recovery.hashes },
    })
    await recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: challenge.adminId },
      action: 'auth.mfa_enrolled',
      entityType: 'PlatformAdmin',
      entityId: challenge.adminId,
      orgId: null,
      after: { mfaEnrolled: true, recoveryCodesIssued: recovery.codes.length },
    })
  })

  // The same code finishes the sign-in, with no redirect, so the codes below
  // are on screen before the admin moves on. It is still inside its 30-second
  // step; if it is not, they sign in again with the next one.
  const signedIn = await finishSignIn({ challengeToken: challenge.token, code, redirect: false })
  return {
    notice: signedIn.error
      ? 'Two-factor authentication is on. Save these recovery codes, then sign in again.'
      : 'Two-factor authentication is on. Save these recovery codes now.',
    recoveryCodes: recovery.codes,
  }
}

// ---------------------------------------------------------------------------
// First password, from db:create-platform-admin's link
// ---------------------------------------------------------------------------

export async function setPlatformPassword(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = String(formData.get('token') ?? '')
  const password = String(formData.get('password') ?? '')
  const invalid = { error: 'That link is no longer valid. Ask for a new one.' }
  if (!(await onPlatformHost())) return invalid
  if (password !== String(formData.get('confirmPassword') ?? '')) {
    return { error: 'Those two passwords do not match.' }
  }
  const violations = validatePassword(password)
  if (violations.length > 0) return { error: violations.map((v) => v.message).join(' ') }

  const redeemed = await redeemToken(token, {
    purpose: 'PLATFORM_PASSWORD_SETUP',
    subjectType: 'PlatformAdmin',
  })
  if (!redeemed.ok) return invalid

  const now = new Date()
  const passwordHash = await hashPassword(password)
  await prisma.$transaction(async (tx) => {
    await tx.platformCredential.update({
      where: { platformAdminId: redeemed.subjectId },
      data: { passwordHash, passwordUpdatedAt: now, failedLoginCount: 0, lockedUntil: null },
    })
    await tx.platformAdmin.update({
      where: { id: redeemed.subjectId },
      data: { sessionsValidFrom: now },
    })
    // The link is the authorisation and it names the admin, so the admin is
    // the actor.
    await recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: redeemed.subjectId, ipAddress: await clientIp() },
      action: 'auth.password_reset',
      entityType: 'PlatformAdmin',
      entityId: redeemed.subjectId,
      orgId: null,
      after: { passwordChanged: true },
    })
  })
  redirect('/platform/login?set=1')
}

export async function signOutOfPlatform(): Promise<void> {
  await platformSignOut({ redirectTo: '/platform/login' })
}
