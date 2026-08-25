import 'server-only'

import type { ChannelAdapter } from './adapter.ts'
import { LiveChannelAdapter } from './live-adapter.ts'

// The wired adapter, in its own module so `send.ts` can import it without
// importing the package barrel that re-exports `send.ts` itself.
//
// Typed as the interface, not the concrete class. R-104 spent that seam:
// swapping the logging adapter for the real Resend and Twilio drivers was
// this one assignment and nothing else, exactly as D-15 said it would be.
// LoggingChannelAdapter is still what runs locally and in CI - see
// live-adapter.ts, which falls back to it wherever a provider is not
// configured, and refuses to on a production deployment.
export const notificationAdapter: ChannelAdapter = new LiveChannelAdapter()
