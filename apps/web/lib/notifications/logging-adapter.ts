import 'server-only'

import { randomUUID } from 'node:crypto'
import type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.ts'

// Every send is recorded in the Notification log exactly as a real one would
// be, and then written to the server console instead of being handed to a
// provider.
//
// STILL THE ADAPTER THAT RUNS ON A LAPTOP AND IN CI, after R-104 wired the
// real drivers. `LiveChannelAdapter` delegates here for any channel whose
// provider is not configured - which locally and in CI is every channel, and
// always will be, because there is no API key on either. It also handles
// PORTAL everywhere: that channel has no provider by design (R-018).
//
// It is NOT a stub for work that was skipped. Everything a real driver has to
// get right is exercised against this one: idempotency, preference
// resolution, quiet-hours deferral, the kill switch, the sandbox redirect,
// failure recording, and the append-only log.
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
