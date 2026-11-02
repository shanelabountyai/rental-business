// Support access grants (PRD 11 §4.7, §4.14, §5.3, D-353, R-295a): the
// lifecycle as pure decisions, so each refusal is tested with values and the
// actions only say it. The database refuses the same things by trigger and
// CHECK (PLAT-08); these are the sentences.

/// §4.7: a request asks for one of these; an owner may approve it for less.
export const REQUEST_MINUTES = [60, 240, 1440] as const
export const DEFAULT_REQUEST_MINUTES = 240
export const BREAK_GLASS_MINUTES = 60
export const MIN_REQUEST_REASON = 20

export type SupportGrantStatus = 'pending' | 'live' | 'denied' | 'ended' | 'expired'

export interface SupportGrantState {
  kind: 'REQUESTED' | 'BREAK_GLASS'
  requestedMinutes: number
  approvedAt: Date | null
  deniedAt: Date | null
  expiresAt: Date | null
  endedAt: Date | null
  ownersAcknowledgedAt?: Date | null
}

/**
 * Liveness is computed (§5.3): approved or break-glass, not ended, not
 * denied, and `now < expiresAt`. EXPIRED is a live-looking row whose window
 * has passed and that the sweep has not stamped yet; it admits nothing.
 */
export function supportGrantStatus(g: SupportGrantState, now = new Date()): SupportGrantStatus {
  if (g.deniedAt) return 'denied'
  if (g.endedAt) return 'ended'
  if (!g.expiresAt) return 'pending'
  return now.getTime() < g.expiresAt.getTime() ? 'live' : 'expired'
}

export function durationLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`
}

/// What an owner may approve a request for: never more than was asked (§4.14).
export function approvableMinutes(requestedMinutes: number): number[] {
  return REQUEST_MINUTES.filter((m) => m <= requestedMinutes)
}

export function supportRequestRefusal(reason: string, minutes: number): { reason?: string; minutes?: string } | null {
  const out: { reason?: string; minutes?: string } = {}
  if (reason.trim().length < MIN_REQUEST_REASON) out.reason = `Say why in at least ${MIN_REQUEST_REASON} characters. The organisation reads it word for word.`
  if (!(REQUEST_MINUTES as readonly number[]).includes(minutes)) out.minutes = 'Choose 1, 4 or 24 hours.'
  return out.reason || out.minutes ? out : null
}

export function supportApprovalRefusal(g: SupportGrantState, minutes: number, now = new Date()): string | null {
  if (g.kind !== 'REQUESTED' || supportGrantStatus(g, now) !== 'pending') return 'That request is no longer waiting for an answer.'
  if (!approvableMinutes(g.requestedMinutes).includes(minutes)) return 'Choose a duration no longer than the one requested.'
  return null
}

export function supportDenialRefusal(g: SupportGrantState, now = new Date()): string | null {
  return g.kind === 'REQUESTED' && supportGrantStatus(g, now) === 'pending' ? null : 'That request is no longer waiting for an answer.'
}

/// "End now" from the platform withdraws a pending request or ends a live
/// grant; "Revoke now" from the org ends a live one (a pending one is denied).
export function supportEndRefusal(g: SupportGrantState, side: 'platform' | 'org', now = new Date()): string | null {
  const status = supportGrantStatus(g, now)
  if (status === 'live' || (side === 'platform' && status === 'pending')) return null
  return status === 'expired' ? 'That grant has already expired.' : 'That grant is no longer open.'
}

export function supportAcknowledgeRefusal(g: SupportGrantState): string | null {
  if (g.kind !== 'BREAK_GLASS') return 'Only emergency access asks to be acknowledged.'
  return g.ownersAcknowledgedAt ? 'Another owner has already marked this as seen.' : null
}
