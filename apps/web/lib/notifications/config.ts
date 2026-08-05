import 'server-only'

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
// one address while recording the address it WOULD have used, so a staging
// environment can exercise the whole path against real-looking recipients and
// reach nobody.
//
// Both are deliberately environment variables and not database rows: a kill
// switch that needs a working database to read is a kill switch that does not
// work during the incident where the database is the problem.

export interface NotificationConfig {
  /// False stops every send. Notifications are still recorded, as SUPPRESSED
  /// with reason `kill_switch`.
  enabled: boolean
  /// When set, every send is redirected here regardless of recipient. The
  /// intended address is preserved on the notification record.
  sandboxTo: string | null
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
  const sandboxTo = process.env.NOTIFICATIONS_SANDBOX_TO?.trim()
  return {
    enabled: process.env.NOTIFICATIONS_ENABLED !== 'false',
    sandboxTo: sandboxTo ? sandboxTo : null,
  }
}
