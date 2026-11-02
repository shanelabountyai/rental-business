import 'server-only'

import { RATE_LIMITS, matchRecoveryCode, openSecret, verifyTotp } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { consumeRateLimit } from './store.ts'

/**
 * The org side's step-up (R-295a, D-380): a code proved AT THE PRESS, in the
 * same form, for a signed-in staff member. There is no org step-up page yet
 * (the platform's is `requirePlatform({ stepUp })`, D-365); a code typed into
 * the form that asks for it is stricter than a ten-minute window and needs no
 * session change, so R-299/R-300 may reuse this or build the window.
 *
 * Rate limited per staff member, so one session cannot spend another's
 * budget. A TOTP code, or a recovery code struck once used - the sign-in's
 * own rule (`verifySecondFactor` in auth.ts). The caller audits the act the
 * code authorised; a separate `auth.step_up` row would say the same thing.
 */
export async function verifyStaffStepUp(staffUserId: string, code: string): Promise<boolean> {
  if (!code) return false
  const limit = await consumeRateLimit(`mfa:staff-step-up:${staffUserId}`, RATE_LIMITS.mfaVerify)
  if (!limit.allowed) return false
  const credential = await prisma.staffCredential.findUnique({
    where: { staffUserId },
    select: { id: true, mfaSecret: true, mfaEnrolledAt: true, mfaRecoveryCodes: true },
  })
  if (!credential?.mfaEnrolledAt || !credential.mfaSecret) return false
  const secret = openSecret(credential.mfaSecret)
  if (secret && verifyTotp(secret, code)) return true
  const matched = matchRecoveryCode(code, credential.mfaRecoveryCodes)
  if (!matched) return false
  await prisma.staffCredential.update({
    where: { id: credential.id },
    data: { mfaRecoveryCodes: credential.mfaRecoveryCodes.filter((h) => h !== matched) },
  })
  return true
}
