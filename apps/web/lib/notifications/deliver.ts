import 'server-only'

import type { NotificationChannel } from '@rental/core/notifications'
import { notificationConfig } from './config.ts'
import { notificationAdapter } from './provider.ts'

// The single place anything in this product hands a message to a provider.
//
// Extracted at R-017 so the comms threading module can reuse it. CLAUDE.md's
// rule is that no module hand-rolls its own sending, and a staff member's
// free-text reply to a tenant still has to go out over SMS or email somehow -
// so it goes through here, exactly as a templated notification does.
//
// What is SHARED between the two paths, and must be, is everything that keeps
// a mistake from reaching a real person: the kill switch and the sandbox
// redirect. Those are properties of "this environment may/may not contact
// humans", which has nothing to do with why the message exists.
//
// What is NOT shared is deliberate. A notification is system-initiated, so it
// is templated, preference-gated and quiet-hours-deferred. A conversation
// message is a human replying inside a thread the recipient started, so none
// of those apply - COMM-07 scopes quiet hours to "automated outbound"
// precisely because a manager answering a tenant at 9pm is not spam, and
// preference-gating a direct reply would silently drop an answer to a
// question the tenant just asked.

export interface DeliveryOutcome {
  status: 'SENT' | 'SUPPRESSED' | 'FAILED'
  externalId?: string
  /// Set when SUPPRESSED - today only ever 'kill_switch'.
  suppressedReason?: string
  /// Set when FAILED.
  failureCode?: string
}

/**
 * Sends one message, honouring the kill switch and the sandbox redirect.
 *
 * Never throws for a provider failure: the caller has already written the
 * message to the log as evidence, and losing that write because the provider
 * was down would be the worse outcome. The failure is returned to be recorded
 * on the delivery row.
 */
export async function deliverOverChannel(args: {
  channel: NotificationChannel
  /// The intended recipient. Redirected here if a sandbox address is set; the
  /// caller stores the INTENDED address as evidence regardless.
  to: string
  subject?: string
  body: string
}): Promise<DeliveryOutcome> {
  const config = notificationConfig()
  if (!config.enabled) {
    return { status: 'SUPPRESSED', suppressedReason: 'kill_switch' }
  }
  if (!notificationAdapter.supports(args.channel)) {
    return { status: 'SUPPRESSED', suppressedReason: 'unsupported_channel' }
  }

  const to = config.sandboxTo ?? args.to
  const body = config.sandboxTo
    ? `[sandbox: intended for ${args.to}]\n\n${args.body}`
    : args.body

  try {
    const result = await notificationAdapter.send({
      channel: args.channel,
      to,
      subject: args.subject,
      body,
    })
    return { status: 'SENT', externalId: result.externalId }
  } catch (error) {
    const failureCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'
    console.error(`[deliver] ${args.channel} send failed`, error)
    return { status: 'FAILED', failureCode }
  }
}
