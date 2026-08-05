import 'server-only'

// The notification engine's public surface (NOTIF-01, R-016). Every module
// that needs to tell somebody something imports `notify` from here.
export type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.ts'
export { ChannelSendError } from './adapter.ts'
export { notificationConfig } from './config.ts'
export { notificationAdapter } from './provider.ts'
export {
  type ChannelOutcome,
  type DispatchResult,
  type NotificationRecipient,
  type NotifyInput,
  dispatchPendingNotifications,
  notify,
} from './send.ts'
