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
  /// R-097a (COMM-08): where a reply should go, when the message belongs to
  /// a conversation. Email only - an SMS reply comes back to the number it
  /// was sent from, which R-017 already routes. An adapter that cannot set
  /// a Reply-To simply ignores it: the reply then arrives at the default
  /// inbound address and routes by From:, which is a graceful degradation
  /// rather than a failure.
  replyTo?: string
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
