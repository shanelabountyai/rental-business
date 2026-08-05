// Which channels a notification actually goes out on (NOTIF-01's "channel per
// preference", NOTIF-02's per-category preferences).
//
// Pure. The engine hands in what it has already loaded and gets back a
// decision per channel - so the rule "a locked category cannot be silenced"
// is one testable function rather than a condition repeated at every call
// site that might send something legally significant.

import {
  type NotificationCategory,
  type NotificationChannel,
  defaultEnabled,
  isLockedCategory,
} from './categories.ts'

/// Why a channel was not used. Stored on NotificationDelivery.suppressedReason
/// when the engine records the decision, which is the whole point of writing a
/// row for something that was never sent.
export const SUPPRESSION_REASONS = [
  'preference_off',
  'no_address',
  'kill_switch',
  'unsupported_channel',
] as const

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

export interface PreferenceRow {
  category: string
  channel: string
  enabled: boolean
}

export interface ChannelDecision {
  channel: NotificationChannel
  send: boolean
  reason?: SuppressionReason
}

export interface ResolveChannelsInput {
  category: NotificationCategory
  /// The channels this particular notification could go out on - normally
  /// derived from what the recipient has an address for, and narrowed further
  /// by the caller when a template only exists for some of them.
  candidates: readonly NotificationChannel[]
  /// This recipient's stored overrides. Rows for other categories are
  /// harmless; they are filtered here.
  preferences: readonly PreferenceRow[]
}

/**
 * The decision for every candidate channel, in the order given.
 *
 * A locked category (NOTIF-02) ignores a preference row saying otherwise
 * rather than treating its existence as an error: preferences are data, the
 * lock list is policy, and policy that changes with the law must win over a
 * row somebody wrote when the rules were different. The settings UI refuses
 * to create such a row in the first place; this is the backstop that makes
 * that refusal something other than a client-side courtesy.
 */
export function resolveChannels(
  input: ResolveChannelsInput,
): ChannelDecision[] {
  const locked = isLockedCategory(input.category)

  return input.candidates.map((channel) => {
    if (locked) return { channel, send: true }

    const override = input.preferences.find(
      (row) => row.category === input.category && row.channel === channel,
    )
    const enabled = override?.enabled ?? defaultEnabled(input.category, channel)

    return enabled
      ? { channel, send: true }
      : { channel, send: false, reason: 'preference_off' as const }
  })
}
