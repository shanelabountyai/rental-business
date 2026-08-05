// The notification vocabulary (NOTIF-01, NOTIF-02, R-016).
//
// Closed, for the same reason permissions, audit actions and domain events
// are: a free-text category produces `rent_reminder`, `rentReminder` and
// `rent-reminder` in the same preference table within a year, and then
// "which categories has this tenant turned off" has no answer.
//
// Two properties of a category matter to the engine and to nothing else:
// whether a recipient is allowed to turn it off, and whether it may wake
// somebody at 3am. Both are policy that lives here, not per-call-site
// booleans a caller could get wrong.

/// Value-identical to the subset of Prisma's MessageChannel that a
/// notification can actually go out on - CALL_LOG is an inbound record of a
/// phone call (COMM-01), never something this engine sends.
///
/// A TYPE-only import, deliberately: importing the Prisma enum as a VALUE
/// drags the whole client into any client component that touches this file,
/// which is the bundle crash R-010 and R-012 both hit. `satisfies` gives the
/// same compile-time guarantee with none of the runtime weight.
import type { MessageChannel } from '@rental/db'

export const NOTIFICATION_CHANNELS = [
  'EMAIL',
  'SMS',
  'PORTAL',
] as const satisfies readonly MessageChannel[]

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const NOTIFICATION_CATEGORIES = [
  // Money (NOTIF-03, PAY-02)
  'rent_reminder',
  'payment_receipt',
  'payment_failed',
  'autopay_predebit',

  // Legally significant. Locked on - see LOCKED_CATEGORIES.
  'legal_notice',
  'entry_notice',

  // Maintenance
  'maintenance_update',
  'maintenance_emergency',
  'work_order_assigned',

  // Tenancy
  'lease_renewal',
  'move_out',

  // Staff-facing operations
  'approval_needed',
  'task_assigned',
  'unit_make_ready',
  'compliance_due',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

const CATEGORY_SET: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORIES)

export function isNotificationCategory(
  value: string,
): value is NotificationCategory {
  return CATEGORY_SET.has(value)
}

/**
 * Categories a recipient may not switch off, and the explanation NOTIF-02
 * requires be shown next to them ("legally-critical categories locked on with
 * explanation").
 *
 * The explanation is stored here rather than written into the settings page,
 * because the reason a category is locked is the same reason wherever it is
 * asked - the preferences screen, an API refusal, or a support conversation.
 *
 * Emergency maintenance is on this list for a non-legal reason that is just
 * as strong: a tenant who muted it and then had a gas leak is a case nobody
 * wants to defend, and MAINT-01 routes gas smell to "call the gas company and
 * 911 first" precisely because the stakes are not recoverable.
 */
export const LOCKED_CATEGORIES: Readonly<
  Partial<Record<NotificationCategory, string>>
> = {
  legal_notice:
    'Legal notices must reach you to be effective. Turning these off could invalidate a notice you are entitled to receive.',
  entry_notice:
    'Advance notice before someone enters your home is required by law in most states, and the required hours come from your property’s own jurisdiction rules.',
  maintenance_emergency:
    'Emergency maintenance can involve gas, flooding, or loss of heat. These reach you whatever your other settings say, including during quiet hours.',
}

export function isLockedCategory(category: NotificationCategory): boolean {
  return category in LOCKED_CATEGORIES
}

export function lockedReason(
  category: NotificationCategory,
): string | undefined {
  return LOCKED_CATEGORIES[category]
}

/**
 * Categories that ignore quiet hours (NOTIF-05: "quiet hours respected except
 * emergencies").
 *
 * Deliberately narrower than LOCKED_CATEGORIES: a legal notice may not be
 * turned off, but it can wait until 8am - there is no legal notice whose
 * validity depends on arriving at 2am, and a product that pages people
 * overnight for routine paperwork trains them to ignore the channel that
 * matters. Only genuine emergencies are here.
 */
export const EMERGENCY_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'maintenance_emergency',
])

export function bypassesQuietHours(category: NotificationCategory): boolean {
  return EMERGENCY_CATEGORIES.has(category)
}

/**
 * Whether a category is on by default on a given channel, before any
 * preference row is consulted.
 *
 * Defaults rather than a seeded row per person per category per channel: a
 * new category must be sendable the day it is added, without a backfill, and
 * an absent preference row is then unambiguously "never expressed an opinion"
 * rather than "was created before this category existed".
 *
 * SMS defaults OFF for everything that is not urgent. Texting somebody costs
 * them attention in a way email does not, and 10DLC carrier filtering
 * punishes senders whose recipients report low-value messages as spam - so
 * the default is the conservative one and opting IN is a deliberate act.
 */
export function defaultEnabled(
  category: NotificationCategory,
  channel: NotificationChannel,
): boolean {
  if (channel === 'PORTAL') return true
  if (channel === 'EMAIL') return true
  // SMS
  return (
    isLockedCategory(category) ||
    category === 'payment_failed' ||
    category === 'work_order_assigned'
  )
}
