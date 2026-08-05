// The provider contract every outbound notification goes through (NOTIF-01:
// "no module hand-rolls sending"). One seam, one place to swap Resend and
// Twilio in - the same shape D-14 gave file storage, and for the same reason.
//
// See index.ts for which adapter is wired today and why the real drivers are
// not.

import type { NotificationChannel } from '@rental/core/notifications'

export interface OutboundMessage {
  channel: NotificationChannel
  /// Email address or E.164 phone, already resolved and already redirected if
  /// a sandbox address is configured. An adapter never decides who to send to.
  to: string
  subject?: string
  body: string
}

export interface SendResult {
  /// Provider message id (Resend id, Twilio SID), when the provider returns
  /// one. Stored on NotificationDelivery.externalId for webhook
  /// reconciliation.
  externalId?: string
}

export class ChannelSendError extends Error {
  /// Provider error code, stored on NotificationDelivery.failureCode. A
  /// stable code is what a later retry policy can branch on; the message is
  /// for a human reading the log.
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChannelSendError'
    this.code = code
  }
}

export interface ChannelAdapter {
  /// Which channels this adapter can deliver. The engine records
  /// `unsupported_channel` rather than throwing when a channel is not covered
  /// - a missing SMS provider must not stop the email going out.
  supports(channel: NotificationChannel): boolean
  send(message: OutboundMessage): Promise<SendResult>
}
