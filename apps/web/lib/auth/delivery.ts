import 'server-only'

// The seam where auth links leave the system.
//
// CLAUDE.md: "Every module sends notifications through the notification engine
// (R-030) - no module hand-rolls its own sending." R-003 therefore does not
// send anything. It calls this, and R-030 replaces the body with a real
// engine call once Resend and Twilio exist.
//
// Until then, links are written to the server log in development and dropped
// in production. Dropped, not logged: a production log line containing a live
// magic link is a credential in a log aggregator, and this file exists
// precisely to keep that from happening by accident.

export type AuthLinkKind =
  | 'tenant_magic_link'
  | 'staff_password_reset'
  | 'tenant_password_reset'
  | 'vendor_work_order'

export interface AuthLinkDelivery {
  kind: AuthLinkKind
  /// Email address or phone number, depending on the recipient's preference.
  /// R-030 resolves the channel; R-003 only knows who to hand it to.
  to: string
  url: string
  expiresAt: Date
}

export async function deliverAuthLink(
  delivery: AuthLinkDelivery,
): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // R-030 replaces this. Failing loudly would break login for everyone the
    // moment it deploys ahead of the notification engine; failing silently
    // here is survivable because no production tenant exists yet.
    console.warn(
      `[auth] ${delivery.kind} not delivered: the notification engine (R-030) is not wired up yet.`,
    )
    return
  }

  console.info(
    `\n[auth:dev] ${delivery.kind} for ${delivery.to}\n  ${delivery.url}\n  expires ${delivery.expiresAt.toISOString()}\n`,
  )
}

/// Builds an absolute URL from AUTH_URL. Deliberately not derived from the
/// request's Host header: an attacker who can set Host could otherwise have a
/// password-reset link built against their own domain and mailed to the real
/// user.
export function authUrl(path: string): string {
  const base = process.env.AUTH_URL
  if (!base) {
    throw new Error('AUTH_URL is not set; auth links cannot be built.')
  }
  return new URL(path, base).toString()
}
