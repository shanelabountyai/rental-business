import {
  isLockedOut,
  matchRecoveryCode,
  openSecret,
  verifyTotp,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { redeemToken } from './lib/auth/store.ts'

// Auth.js v5, JWT sessions, no database adapter.
//
// Why no adapter: the adapter's `User` table would have to be the one identity
// for both staff and tenants, and R-002 settled those as distinct entities for
// good domain reasons - a tenant is not an employee with fewer permissions.
// Two Credentials providers over our own tables is less machinery than
// bending the adapter around a shape it does not have.
//
// Why JWT: Auth.js does not support database sessions with the Credentials
// provider. That is a documented limitation, not a preference, and it creates
// a real problem - ROLE-06 requires that deactivating a user kills their
// access within a minute, and a signed JWT cannot be deleted server-side.
//
// The answer is the `sessionsValidFrom` watermark on StaffUser and Tenant. The
// jwt callback below re-reads the principal on EVERY request and rejects the
// token if the account went inactive or the watermark moved past the token's
// issue time. Password reset, deactivation and "sign out everywhere" are all
// one column update.
//
// ponytail: that is a database round-trip per authenticated request. At 10-50
// units with a three-person team it is invisible. If it ever shows up in a
// trace, cache the (userId -> active, sessionsValidFrom) pair for ~30 seconds
// and accept a revocation delay inside ROLE-06's one-minute budget - do not
// remove the check.

/// What the product knows about whoever is signed in. R-004 adds roles and
/// property scope on top; this is authentication only.
export interface Principal {
  id: string
  kind: 'staff' | 'tenant'
  email: string | null
  name: string
  /// Whether this staff user has completed MFA enrolment at all.
  mfaEnrolled: boolean
  /// Whether the second factor was proved during THIS sign-in. ROLE-05 makes
  /// this the gate on privileged actions, and R-004 owns that enforcement -
  /// nothing here blocks on it.
  mfaVerified: boolean
}

declare module 'next-auth' {
  interface Session {
    principal: Principal
  }
}

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: '/login', error: '/login' },
  providers: [
    /**
     * Second half of the staff login. The first half - rate limiting, password
     * verification, lockout - happens in the sign-in server action, which
     * issues a single-use STAFF_MFA_CHALLENGE token on success. This provider
     * redeems it, and demands a TOTP or recovery code first if the account is
     * enrolled.
     *
     * The password is therefore never resubmitted for the second factor.
     */
    Credentials({
      id: 'staff-challenge',
      credentials: {
        challengeToken: {},
        code: {},
      },
      authorize: async (raw) => {
        const challengeToken = asString(raw.challengeToken)
        if (!challengeToken) return null

        // Peek before burning: an account with MFA enrolled must not have its
        // one-shot challenge consumed by a wrong code, or a typo would send
        // the user back to the password screen.
        const staffUserId = await peekChallengeSubject(challengeToken)
        if (!staffUserId) return null

        const staffUser = await prisma.staffUser.findUnique({
          where: { id: staffUserId },
          include: { credential: true },
        })
        if (!staffUser?.active || !staffUser.credential) return null
        if (isLockedOut(staffUser.credential.lockedUntil)) return null

        const enrolled = staffUser.credential.mfaEnrolledAt !== null
        let mfaVerified = false

        if (enrolled) {
          const code = asString(raw.code)
          if (!code) return null

          const accepted = await verifySecondFactor(
            staffUser.credential.id,
            staffUser.credential.mfaSecret,
            staffUser.credential.mfaRecoveryCodes,
            code,
          )
          if (!accepted) return null
          mfaVerified = true
        }

        // Burn the challenge only once the whole check has passed.
        const redeemed = await redeemToken(challengeToken, {
          purpose: 'STAFF_MFA_CHALLENGE',
          subjectType: 'StaffUser',
        })
        if (!redeemed.ok) return null

        await prisma.staffCredential.update({
          where: { id: staffUser.credential.id },
          data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
        })

        return {
          id: staffUser.id,
          email: staffUser.email,
          name: staffUser.name,
          kind: 'staff',
          mfaEnrolled: enrolled,
          mfaVerified,
        } as never
      },
    }),

    /**
     * Tenant magic link (ROLE-05: short-lived, single-use). The token arrives
     * from the verify route, is burned here, and is the whole credential -
     * tenants are not required to have a password at all.
     */
    Credentials({
      id: 'tenant-magic-link',
      credentials: { token: {} },
      authorize: async (raw) => {
        const token = asString(raw.token)
        if (!token) return null

        const redeemed = await redeemToken(token, {
          purpose: 'TENANT_MAGIC_LINK',
          subjectType: 'Tenant',
        })
        if (!redeemed.ok) return null

        const tenant = await prisma.tenant.findUnique({
          where: { id: redeemed.subjectId },
        })
        if (!tenant?.active) return null

        return {
          id: tenant.id,
          email: tenant.email,
          name: `${tenant.firstName} ${tenant.lastName}`,
          kind: 'tenant',
          mfaEnrolled: false,
          mfaVerified: false,
        } as never
      },
    }),
  ],

  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        const principal = user as unknown as Principal & { id: string }
        token.kind = principal.kind
        token.mfaEnrolled = principal.mfaEnrolled
        token.mfaVerified = principal.mfaVerified
        token.name = principal.name
        token.email = principal.email
        // Recorded explicitly rather than trusting `iat`, which Auth.js
        // refreshes as the session rolls forward. The watermark comparison
        // needs the moment credentials were actually presented.
        token.authenticatedAt = Date.now()
      }

      // Runs on every authenticated request. Returning null invalidates the
      // session, which is what makes ROLE-06's one-minute revocation real.
      const stillValid = await principalIsStillValid(
        token.sub,
        token.kind as Principal['kind'] | undefined,
        token.authenticatedAt as number | undefined,
      )
      return stillValid ? token : null
    },

    session: ({ session, token }) => {
      session.principal = {
        id: token.sub ?? '',
        kind: (token.kind as Principal['kind']) ?? 'tenant',
        email: (token.email as string | null) ?? null,
        name: (token.name as string) ?? '',
        mfaEnrolled: Boolean(token.mfaEnrolled),
        mfaVerified: Boolean(token.mfaVerified),
      }
      return session
    },
  },
})

async function principalIsStillValid(
  id: string | undefined,
  kind: Principal['kind'] | undefined,
  authenticatedAt: number | undefined,
): Promise<boolean> {
  if (!id || !kind || !authenticatedAt) return false

  const record =
    kind === 'staff'
      ? await prisma.staffUser.findUnique({
          where: { id },
          select: { active: true, sessionsValidFrom: true },
        })
      : await prisma.tenant.findUnique({
          where: { id },
          select: { active: true, sessionsValidFrom: true },
        })

  if (!record?.active) return false
  // Strictly greater-than: a watermark set in the same millisecond as the
  // sign-in belongs to that sign-in, not to a revocation of it.
  return record.sessionsValidFrom.getTime() <= authenticatedAt
}

/// Reads a challenge token's subject WITHOUT consuming it, so a mistyped MFA
/// code does not cost the user their challenge.
async function peekChallengeSubject(rawToken: string): Promise<string | null> {
  const { hashToken, checkToken } = await import('@rental/core/auth')
  const stored = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  })
  const verdict = checkToken(stored, {
    purpose: 'STAFF_MFA_CHALLENGE',
    subjectType: 'StaffUser',
  })
  return verdict.ok ? stored!.subjectId : null
}

/**
 * A TOTP code, or a recovery code if the phone is gone. A spent recovery code
 * is removed in the same call - it is single-use by definition, and leaving it
 * in the list would turn a paper backup into a permanent password.
 */
async function verifySecondFactor(
  credentialId: string,
  sealedSecret: string | null,
  recoveryHashes: string[],
  code: string,
): Promise<boolean> {
  if (sealedSecret) {
    const secret = openSecret(sealedSecret)
    if (secret && verifyTotp(secret, code)) return true
  }

  const matched = matchRecoveryCode(code, recoveryHashes)
  if (!matched) return false

  await prisma.staffCredential.update({
    where: { id: credentialId },
    data: { mfaRecoveryCodes: recoveryHashes.filter((h) => h !== matched) },
  })
  return true
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
