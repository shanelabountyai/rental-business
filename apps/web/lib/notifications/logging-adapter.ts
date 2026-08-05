import 'server-only'

import { randomUUID } from 'node:crypto'
import type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.ts'

// The adapter this build actually runs on. Every send is recorded in the
// Notification log exactly as a real one would be, and then written to the
// server console instead of being handed to a provider.
//
// This is NOT a stub standing in for work that was skipped. There is no
// Resend API key, no verified sending domain, and no approved 10DLC campaign
// - all three are external, human-lead-time workstreams (see this item's
// PROGRESS entry), and until they exist a "real" driver could not be run even
// once, let alone tested. What it would be is an untested HTTP call that
// looks finished, which is worse than an honest seam.
//
// Everything a real driver has to get right is already exercised against this
// one: idempotency, preference resolution, quiet-hours deferral, the kill
// switch, the sandbox redirect, failure recording, and the append-only log.
// Swapping in Resend and Twilio is a change to `notificationAdapter` in
// index.ts and nothing else.
export class LoggingChannelAdapter implements ChannelAdapter {
  supports(): boolean {
    return true
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const externalId = `log_${randomUUID()}`
    console.info(
      `[notifications] ${message.channel} -> ${message.to}${
        message.subject ? ` | ${message.subject}` : ''
      }\n${message.body}`,
    )
    return { externalId }
  }
}
