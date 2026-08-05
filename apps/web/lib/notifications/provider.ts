import 'server-only'

import type { ChannelAdapter } from './adapter.ts'
import { LoggingChannelAdapter } from './logging-adapter.ts'

// The wired adapter, in its own module so `send.ts` can import it without
// importing the package barrel that re-exports `send.ts` itself.
//
// Typed as the interface, not the concrete class - the point of the seam is
// that swapping in Resend and Twilio later touches this one assignment, the
// same shape lib/storage/index.ts gives D-14's storage adapter.
export const notificationAdapter: ChannelAdapter = new LoggingChannelAdapter()
