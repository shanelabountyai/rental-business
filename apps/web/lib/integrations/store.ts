import 'server-only'

import { openSecret, sealSecret } from '@rental/core/auth'
import { prisma, type IntegrationProvider } from '@rental/db'

// Per-org integration credentials (R-275, PRD 10 §1.2). The only reader and
// writer of `OrgIntegration.secret`: nothing else seals or opens it, so the
// purpose string below cannot drift between two copies.
//
// THE KEY IS BOUND TO THE ROW'S ORG AND PROVIDER. The HKDF purpose names both,
// so org A's sealed Twilio token pasted into org B's row (a bad support edit,
// a restore into the wrong org) opens as null - unavailable - instead of
// sending B's renters texts on A's account. Same AUTH_SECRET caveat as every
// sealed value (secret-box.ts): rotating it makes these unreadable, and each
// org re-enters or re-provisions.

function purpose(orgId: string, provider: IntegrationProvider): string {
  return `org-integration/${orgId}/${provider}`
}

export interface OrgIntegrationValue {
  status: string
  config: Record<string, unknown>
  /// Opened plaintext; null when none is stored or it will not open.
  secret: string | null
}

export async function orgIntegration(
  orgId: string,
  provider: IntegrationProvider,
): Promise<OrgIntegrationValue | null> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: { status: true, config: true, secret: true },
  })
  if (!row) return null
  const config =
    row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {}
  return {
    status: row.status,
    config,
    secret: row.secret ? openSecret(row.secret, purpose(orgId, provider)) : null,
  }
}

/**
 * Upserts one org's row. `secret`: a string seals and replaces, null clears,
 * undefined keeps what is stored. `config` must hold nothing secret - it is
 * what the console (R-303) may display.
 */
export async function saveOrgIntegration(
  orgId: string,
  provider: IntegrationProvider,
  values: {
    status?: string
    statusReason?: string | null
    config?: Record<string, string>
    secret?: string | null
  },
): Promise<void> {
  const secret =
    values.secret === undefined
      ? undefined
      : values.secret === null
        ? null
        : sealSecret(values.secret, purpose(orgId, provider))
  const data = {
    status: values.status,
    statusReason: values.statusReason,
    config: values.config,
    secret,
  }
  await prisma.orgIntegration.upsert({
    where: { orgId_provider: { orgId, provider } },
    create: { orgId, provider, ...data },
    update: data,
  })
}

/**
 * The org a Twilio number is provisioned to (R-292a), or null. Unique by the
 * `OrgIntegration_twilio_number` index, so a number can never name two orgs
 * and hand a forger the choice of token.
 */
export async function orgIdForTwilioNumber(e164: string): Promise<string | null> {
  const row = await prisma.orgIntegration.findFirst({
    where: { provider: 'TWILIO', config: { path: ['phoneNumber'], equals: e164 } },
    select: { orgId: true },
  })
  return row?.orgId ?? null
}
