import { recordAudit } from '@rental/core/audit'
import {
  RATE_LIMITS,
  checkToken,
  hashToken,
  isLockedOut,
  matchRecoveryCode,
  openSecret,
  verifyTotp,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { headers } from 'next/headers'
import { MfaRateLimited } from './auth.ts'
import { isPlatformHost } from './lib/auth/platform-host.ts'
import { PLATFORM_IDLE_SECONDS, PLATFORM_SESSION_COOKIE } from './lib/auth/platform-session.ts'
import { consumeRateLimit, redeemToken } from './lib/auth/store.ts'

// The platform console's own Auth.js instance (PRD 11 §2.3, R-294b).
//
// A SECOND INSTANCE, NOT A FOURTH PROVIDER ON THE FIRST. A provider on the org
// instance would mint the org's cookie, read by the org's `auth()`, so a
// platform session would be one missing `kind` check away from an org page.
// Here the cookie has its own name under the `__Host-` prefix, which a browser
// refuses to set with a `Domain` attribute: however the org cookie is ever
// widened, this one cannot reach another host, and neither instance ever
// reads the other's cookie.
//
// 30 minutes idle (the JWT's maxAge, rolled forward by the proxy on every
// console request) and 4 hours absolute (`authenticatedAt`, checked below),
// against staff's 12: a platform session is rarer and more dangerous.

export interface PlatformPrincipal {
  id: string
  kind: 'platform'
  email: string
  name: string
  /// When a TOTP or recovery code was last proved. Step-up (R-294c) reads it.
  mfaVerifiedAt: number
}

const ABSOLUTE_MS = 4 * 60 * 60_000

export const {
  handlers: platformHandlers,
  auth: platformAuth,
  signIn: platformSignIn,
  signOut: platformSignOut,
} = NextAuth({
  basePath: '/platform/api/auth',
  trustHost: true,
  session: { strategy: 'jwt', maxAge: PLATFORM_IDLE_SECONDS },
  pages: { signIn: '/platform/login', error: '/platform/login' },
  cookies: {
    sessionToken: {
      name: PLATFORM_SESSION_COOKIE,
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
  },
  providers: [
    /**
     * The second half of a platform sign-in, exactly as `staff-challenge` is
     * for staff: the password was proved by `startPlatformSignIn`, which
     * issued a PLATFORM_MFA_CHALLENGE. Unlike staff, a code is ALWAYS required
     * (PADM-02) - an admin who has not enrolled finishes enrolment first, on
     * the same challenge, and arrives here with their first code.
     */
    Credentials({
      id: 'platform-challenge',
      credentials: { challengeToken: {}, code: {} },
      authorize: async (raw) => {
        const challengeToken = asString(raw.challengeToken)
        const code = asString(raw.code)
        if (!challengeToken || !code) return null
        if (!isPlatformHost((await headers()).get('host'))) return null

        const adminId = await peekPlatformChallenge(challengeToken)
        if (!adminId) return null
        const admin = await prisma.platformAdmin.findUnique({
          where: { id: adminId },
          include: { credential: true },
        })
        const credential = admin?.credential
        if (!admin?.active || !credential?.mfaEnrolledAt || !credential.mfaSecret) return null
        if (isLockedOut(credential.lockedUntil)) return null

        // SEC-18's rule: the limit lives in the provider, which is reachable
        // directly at POST /platform/api/auth/callback/platform-challenge.
        const limit = await consumeRateLimit(
          `mfa:platform:${challengeToken.slice(0, 16)}`,
          RATE_LIMITS.mfaVerify,
        )
        if (!limit.allowed) throw new MfaRateLimited()

        const { id, mfaSecret, mfaRecoveryCodes } = credential
        if (!(await verifyPlatformFactor({ id, mfaSecret, mfaRecoveryCodes }, code))) return null

        const redeemed = await redeemToken(challengeToken, {
          purpose: 'PLATFORM_MFA_CHALLENGE',
          subjectType: 'PlatformAdmin',
        })
        if (!redeemed.ok) return null

        await prisma.platformCredential.update({
          where: { id: credential.id },
          data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
        })
        // About the platform, not an org: the one org-less row there is.
        await recordAudit(prisma, {
          actor: { type: 'PLATFORM', ref: admin.id, ipAddress: redeemed.requestedIp },
          action: 'auth.signed_in',
          entityType: 'PlatformAdmin',
          entityId: admin.id,
          orgId: null,
          after: { method: 'password+totp' },
        })

        return { id: admin.id, email: admin.email, name: admin.name } as never
      },
    }),
  ],

  callbacks: {
    // Post-sign-in and sign-out redirects stay RELATIVE. Auth.js resolves
    // them against AUTH_URL, which is an org host (localhost:3100 in e2e,
    // the deployment's own host in production), and would send the browser
    // off the console's host with its session cookie left behind.
    redirect: ({ url }) => {
      if (url.startsWith('/')) return url
      const { pathname, search } = new URL(url)
      return pathname.startsWith('/platform') ? `${pathname}${search}` : '/platform'
    },

    jwt: async ({ token, user }) => {
      if (user) {
        token.kind = 'platform'
        token.authenticatedAt = Date.now()
        token.mfaVerifiedAt = Date.now()
      }
      // Every request: still on the console's host, still active, not
      // revoked by the watermark, inside the absolute lifetime.
      return (await platformSessionIsStillValid(
        token.sub,
        token.kind,
        token.authenticatedAt as number | undefined,
      ))
        ? token
        : null
    },

    session: ({ session, token }) => {
      ;(session as unknown as { principal: PlatformPrincipal }).principal = {
        id: token.sub ?? '',
        kind: 'platform',
        email: (token.email as string) ?? '',
        name: (token.name as string) ?? '',
        mfaVerifiedAt: Number(token.mfaVerifiedAt ?? 0),
      }
      return session
    },
  },
})

/// The signed-in platform admin, or null. Never an org principal: this reads
/// only the `__Host-platform` cookie.
export async function currentPlatformPrincipal(): Promise<PlatformPrincipal | null> {
  const session = (await platformAuth()) as unknown as { principal?: PlatformPrincipal } | null
  return session?.principal?.kind === 'platform' && session.principal.id
    ? session.principal
    : null
}

export async function platformSessionIsStillValid(
  id: string | undefined,
  kind: unknown,
  authenticatedAt: number | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!id || kind !== 'platform' || !authenticatedAt) return false
  if (now - authenticatedAt > ABSOLUTE_MS) return false
  if (!isPlatformHost((await headers()).get('host'))) return false
  const admin = await prisma.platformAdmin.findUnique({
    where: { id },
    select: { active: true, sessionsValidFrom: true },
  })
  return Boolean(admin?.active) && admin!.sessionsValidFrom.getTime() <= authenticatedAt
}

/// Reads a challenge's subject WITHOUT burning it, so a mistyped code - or
/// the time spent enrolling - does not cost the admin their challenge.
export async function peekPlatformChallenge(rawToken: string): Promise<string | null> {
  const stored = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(rawToken) } })
  const verdict = checkToken(stored, {
    purpose: 'PLATFORM_MFA_CHALLENGE',
    subjectType: 'PlatformAdmin',
  })
  return verdict.ok ? stored!.subjectId : null
}

/// A TOTP code under the `platform-mfa` key, or a recovery code, struck once used.
async function verifyPlatformFactor(
  credential: { id: string; mfaSecret: string; mfaRecoveryCodes: string[] },
  code: string,
): Promise<boolean> {
  const secret = openSecret(credential.mfaSecret, PLATFORM_MFA_PURPOSE)
  if (secret && verifyTotp(secret, code)) return true
  const matched = matchRecoveryCode(code, credential.mfaRecoveryCodes)
  if (!matched) return false
  await prisma.platformCredential.update({
    where: { id: credential.id },
    data: { mfaRecoveryCodes: credential.mfaRecoveryCodes.filter((h) => h !== matched) },
  })
  return true
}

/// PADM-02: its own HKDF purpose, so a staff seed's key can never open a
/// platform seed or the reverse.
export const PLATFORM_MFA_PURPOSE = 'platform-mfa'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
