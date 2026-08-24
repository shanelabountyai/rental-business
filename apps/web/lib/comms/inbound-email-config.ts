import 'server-only'

// Where inbound email arrives (COMM-08, R-097a).
//
// AN ENVIRONMENT VARIABLE, AND UNSET IS A SUPPORTED STATE. A portfolio that
// has not set up an inbound domain still sends email and still receives
// replies at whatever address its provider forwards - those simply route by
// From: address, which is R-017's ordinary path and refuses to guess exactly
// as it does for SMS. What is lost without a domain is thread PRECISION, not
// the feature.
//
// Read per call rather than captured at module load, matching
// notifications/config.ts and for the same reason: a change takes effect on
// the next send.

export interface InboundEmailConfig {
  localPart: string
  domain: string
}

export function inboundEmailConfig(): InboundEmailConfig | null {
  const address = process.env.INBOUND_EMAIL_ADDRESS?.trim()
  if (!address) return null
  const [localPart, domain] = address.toLowerCase().split('@')
  // A half-configured address is treated as unset rather than as an error.
  // The alternative is a deploy where one malformed variable stops every
  // outbound email carrying a Reply-To, which is a worse failure than
  // falling back to From: matching.
  if (!localPart || !domain) {
    console.error(`[inbound-email] INBOUND_EMAIL_ADDRESS is not an address: ${address}`)
    return null
  }
  return { localPart, domain }
}
