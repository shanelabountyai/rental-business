import 'server-only'

import type { NotificationChannel } from '@rental/core/notifications'

// The two safety controls a notification engine is negligent without.
//
// KILL SWITCH. Something will eventually go wrong in a way that sends the
// same message to every tenant in the portfolio - a botched migration, a job
// that loops, a template with a bad loop bound. The only useful response is a
// switch that stops sending in under a minute without a deploy, and every
// send path has to read it. NOTIFICATIONS_ENABLED=false does that; the
// notifications are still DECIDED and RECORDED as suppressed, so afterwards
// there is a complete list of exactly what would have gone out.
//
// SANDBOX REDIRECT. The one that prevents the incident nobody recovers from:
// texting real tenants from a developer's laptop because it was pointed at a
// copy of production data. NOTIFICATIONS_SANDBOX_TO redirects every send to
// your own address while recording the address it WOULD have used, so a
// staging environment can exercise the whole path against real-looking
// recipients and reach nobody.
//
// IT TAKES ONE ADDRESS PER CHANNEL, comma-separated - an email address and a
// phone number. One value still works and still redirects everything, which
// is what it did before R-104: with the logging adapter wired, one string was
// enough because nothing parsed it. Real drivers do parse it, and an email
// address in Twilio's `To` is a rejected message rather than a redirected
// one - so exercising both channels in one pass needed both here.
//
// Both are deliberately environment variables and not database rows: a kill
// switch that needs a working database to read is a kill switch that does not
// work during the incident where the database is the problem.

export interface NotificationConfig {
  /// False stops every send. Notifications are still recorded, as SUPPRESSED
  /// with reason `kill_switch`.
  enabled: boolean
  /// The addresses every send is redirected to, regardless of recipient -
  /// empty when the redirect is off. Read it through `sandboxAddressFor`,
  /// which picks the one that suits the channel. The intended address is
  /// preserved on the notification record either way.
  sandboxTo: readonly string[]
}

/**
 * Read per call rather than captured at module load, so flipping the switch
 * takes effect on the next send rather than the next cold start.
 *
 * Defaults to ENABLED. A missing variable meaning "off" would be a silent,
 * portfolio-wide outage on any deploy that forgot to set it - a notification
 * that quietly never arrives is the failure mode this whole engine exists to
 * make impossible, and the default must not be it. The sandbox redirect is
 * the control that makes an enabled-by-default engine safe in a non-production
 * environment, which is why the two are read together.
 */
export function notificationConfig(): NotificationConfig {
  return {
    enabled: process.env.NOTIFICATIONS_ENABLED !== 'false',
    sandboxTo: (process.env.NOTIFICATIONS_SANDBOX_TO ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean),
  }
}

/**
 * The sandbox address to use for one channel, or null when the redirect is
 * off.
 *
 * An '@' is the whole test, which is enough: these two shapes cannot be
 * confused with each other, and the value is typed by whoever set the
 * variable rather than by a stranger. A single configured address is used for
 * EVERY channel - unchanged from before there were two - so a mismatched one
 * still fails loudly at the provider rather than quietly reaching a real
 * person, which is the direction to fail in.
 */
export function sandboxAddressFor(
  channel: NotificationChannel,
  addresses: readonly string[],
): string | null {
  const wantsEmail = channel === 'EMAIL'
  return addresses.find((address) => address.includes('@') === wantsEmail) ?? addresses[0] ?? null
}
