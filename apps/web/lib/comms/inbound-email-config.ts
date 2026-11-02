import 'server-only'

import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { orgIntegration, resendSecrets } from '@/lib/integrations/store.ts'

// Where an org's inbound email arrives (COMM-08, R-097a; per org since R-293).
//
// UNSET IS A SUPPORTED STATE. An org with no inbound address still sends email
// and still receives replies at whatever address its provider forwards - those
// simply route by From: address, which is R-017's ordinary path and refuses to
// guess exactly as it does for SMS. What is lost is thread PRECISION, not the
// feature.
//
// WHOSE (R-293, D-362's rule applied to receiving as D-374 applied it to SMS).
// The org's RESEND row first: `config.inboundAddress` and the sealed inbound
// secret. Org #0 with no row keeps INBOUND_EMAIL_ADDRESS/INBOUND_EMAIL_SECRET,
// which are its own; any other org with no row has neither, so org #1's
// webhook can never be authorised by org #0's secret.
//
// Read per call rather than captured at module load, matching
// notifications/config.ts and for the same reason: a change takes effect on
// the next send.

export interface InboundEmailConfig {
  localPart: string
  domain: string
}

export async function inboundEmailConfig(orgId: string): Promise<InboundEmailConfig | null> {
  const row = await orgIntegration(orgId, 'RESEND')
  // A SIMULATED domain (R-293b) has no MX anywhere: a Reply-To there loses
  // the renter's reply, which is worse than routing it by From:.
  const simulated = row?.config.provisionedBy === 'simulated'
  const raw = row ? (simulated ? null : row.config.inboundAddress) : orgId === DEFAULT_ORG_ID ? process.env.INBOUND_EMAIL_ADDRESS : null
  const address = typeof raw === 'string' ? raw.trim() : ''
  if (!address) return null
  const [localPart, domain] = address.toLowerCase().split('@')
  // A half-configured address is treated as unset rather than as an error.
  // The alternative is a deploy where one malformed value stops every
  // outbound email carrying a Reply-To, which is a worse failure than
  // falling back to From: matching.
  if (!localPart || !domain) {
    console.error(`[inbound-email] the inbound address for ${orgId} is not an address: ${address}`)
    return null
  }
  return { localPart, domain }
}

/// The secret the org's inbound webhook must present, or null for none.
export async function inboundEmailSecret(orgId: string): Promise<string | null> {
  const row = await orgIntegration(orgId, 'RESEND')
  if (row) return resendSecrets(row.secret).inboundSecret ?? null
  if (orgId !== DEFAULT_ORG_ID) return null
  return process.env.INBOUND_EMAIL_SECRET?.trim() || null
}
