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
  /// R-063: a signer's own review-and-sign link for a lease sent for
  /// e-signature. Its own category rather than folded into `lease_renewal`
  /// - a guarantor recipient (NotificationRecipientType.GUARANTOR) is never
  /// party to a renewal, so a single toggle covering both would let a
  /// guarantor mute the one message actually addressed to them.
  'lease_signature',

  /// Staff-authored broadcasts to a segment - "the city is flushing hydrants
  /// Tuesday" (COMM-04, R-053). Informational, not a per-tenancy event, so it
  /// gets its own category rather than riding on `rent_reminder` the way the
  /// managed-template carrier already does for the bulk chase - a tenant who
  /// muted rent reminders must not also lose hydrant-flushing notices, and
  /// the reverse.
  'announcement',

  // Staff-facing operations
  'approval_needed',
  'task_assigned',
  'unit_make_ready',
  'compliance_due',
  /// R-032a. A vendor answered, or said something, on a job we sent them.
  /// Its own category rather than folded into `work_order_assigned`, which
  /// is about a job going OUT: these are the replies coming back, and an
  /// operator who wants one without the other has to be able to say so.
  'vendor_response',

  /// The combined email R-054/NOTIF-04 sends instead of several separate
  /// ones. Its own category so it shows up in the send log like anything
  /// else - see DIGEST_ELIGIBLE_CATEGORIES for what it can carry.
  'digest_daily',

  /// R-058: the identical five-question pre-screening invite sent to every
  /// prospect. Its own category, not folded into anything a tenant-facing
  /// preference could touch - a PROSPECT recipient has no preferences to
  /// read in the first place (no account exists yet to hold one).
  'prospect_prescreening',

  /// R-059: every application-pipeline message an APPLICANT recipient gets -
  /// the invite to apply, a co-applicant's own invite, and the fee-paid
  /// confirmation. One category rather than three, unlike prospect
  /// pre-screening's own single-purpose one: these all share the identical
  /// "no account, no preferences to read" reasoning and none of them are
  /// PM-editable content, so splitting them would not buy anything a
  /// template key does not already give for free.
  'prospect_application',

  /// R-064: a prospect's own showing booking confirmation and its T-1-day/
  /// T-2-hour reminders. Its own category, same reasoning as
  /// `prospect_prescreening` - a PROSPECT recipient has no account and
  /// therefore no preferences to read.
  'prospect_showing',

  /// R-068 phase 2: a tenant's own inspection report is ready for their
  /// review and signature, and the follow-up when it auto-finalized
  /// instead because nobody signed in time. Unlike `lease_signature`, a
  /// TENANT recipient here already has portal access by definition (an
  /// inspection happens during an active tenancy, never before move-in) -
  /// no reason to restrict this to EMAIL/SMS the way that category does.
  'inspection_signature',

  /// R-139: the link that IS the sign-in - a tenant's magic link and a staff
  /// password-setup or reset link. Its own category rather than folded into
  /// anything above, for a reason none of them share: every other message
  /// here is ABOUT a tenancy, and this one is how somebody proves they are
  /// party to it in the first place. A recipient who muted it could never
  /// sign in again, and could not reach the preferences screen to unmute it -
  /// which is why it is on LOCKED_CATEGORIES with the bluntest explanation on
  /// that list.
  'account_access',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/**
 * Categories NOTIF-04 may batch into one daily email instead of sending
 * individually - "non-urgent" read narrowly. Left off: anything
 * money-timing-sensitive (`payment_receipt`, `payment_failed`,
 * `autopay_predebit`, `rent due today`), anything that needs a prompt
 * decision (`approval_needed`, `vendor_response`), a locked category (never
 * reaches here - LOCKED_CATEGORIES always sends), and `move_out` /
 * `work_order_assigned`, which start a clock somebody is meant to act on
 * today.
 */
export const DIGEST_ELIGIBLE_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'rent_reminder',
  'maintenance_update',
  'lease_renewal',
  'announcement',
  'unit_make_ready',
  'compliance_due',
  'task_assigned',
])

export function isDigestEligible(category: NotificationCategory): boolean {
  return DIGEST_ELIGIBLE_CATEGORIES.has(category)
}

/**
 * Channels a category may be TOGGLED on, beyond "every channel" (the
 * default every other category gets). `digest_daily` only ever goes by
 * EMAIL - see the digest template - so an SMS or portal toggle for it would
 * promise something the engine never does. Consulted by the preferences
 * screen and its save action; `resolveChannels` itself does not need it,
 * because a channel with no address or no template variant already falls
 * out on its own.
 */
const CATEGORY_CHANNELS: Partial<Record<NotificationCategory, readonly NotificationChannel[]>> = {
  digest_daily: ['EMAIL'],
  /// R-139. EMAIL only, and PORTAL in particular is a contradiction: the
  /// portal is what the link exists to let them into, so a sign-in link
  /// delivered there could only be read by somebody who did not need it. SMS
  /// is deliberately not offered YET - `deliverAuthLink` has only ever taken
  /// one address and every live caller passes an email - rather than being
  /// ruled out on principle; an SMS magic link is the obvious thing R-021's
  /// phone-only tenant wants next.
  account_access: ['EMAIL'],
  /// Never PORTAL - a prospect has no account and no portal to read one in
  /// (NotificationRecipientType.PROSPECT's own schema comment).
  prospect_prescreening: ['EMAIL', 'SMS'],
  /// Same reasoning, same restriction - an APPLICANT has no account either
  /// (NotificationRecipientType.APPLICANT's own schema comment).
  prospect_application: ['EMAIL', 'SMS'],
  /// Same reasoning again - a PROSPECT has no account and no portal to read
  /// one in.
  prospect_showing: ['EMAIL', 'SMS'],
  /// A GUARANTOR has a portal now (R-165), but a financial-only one with no
  /// lease-signing surface in it (LEASE-06: "no portal access to
  /// maintenance/comms" - signing is neither), and a TENANT signing a
  /// brand-new lease may not have set one up yet either - the signing link
  /// goes to its own token-gated page (`/sign/[token]`), not the portal, so
  /// PORTAL would promise a read surface that does not apply for either
  /// recipient.
  lease_signature: ['EMAIL', 'SMS'],
}

export function channelsFor(
  category: NotificationCategory,
): readonly NotificationChannel[] {
  return CATEGORY_CHANNELS[category] ?? NOTIFICATION_CHANNELS
}

/**
 * Categories that SOLICIT rather than inform (R-051b, COMM-02).
 *
 * EMPTY TODAY, AND THAT IS THE POINT. Every category above concerns a tenancy
 * the recipient is already in - rent that is due, a repair, a notice, a job
 * assignment. None of it is marketing, so under the TCPA every one of them is
 * transactional and an existing-relationship basis covers it.
 *
 * This set exists so that the first category which ISN'T has to be declared
 * here to work, rather than quietly inheriting a consent basis that does not
 * cover it. A renewal *offer* pitched to a tenant who has not consented in
 * writing is the exact message this list is waiting for.
 */
export const PROMOTIONAL_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([])

export function categoryPurpose(
  category: NotificationCategory,
): 'TRANSACTIONAL' | 'PROMOTIONAL' {
  return PROMOTIONAL_CATEGORIES.has(category) ? 'PROMOTIONAL' : 'TRANSACTIONAL'
}

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
  lease_signature:
    'This is how you review and sign your lease. Turning it off would leave nobody able to reach you to finish signing.',
  account_access:
    'This is how you sign in. Turning it off would lock you out of your account, including out of this page to turn it back on.',
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
  // Opt-IN, unlike everything else here: batching is a deliberate choice to
  // hear about things later rather than now, and defaulting it on would mean
  // "non-urgent" is decided for a recipient who never asked for it.
  if (category === 'digest_daily') return false
  if (channel === 'PORTAL') return true
  if (channel === 'EMAIL') return true
  // SMS
  return (
    isLockedCategory(category) ||
    category === 'payment_failed' ||
    category === 'work_order_assigned' ||
    // R-058: a transactional reply to a form the prospect just submitted,
    // to a number they just typed in themselves - not an ongoing
    // relationship they might want fewer texts from. Defaulting this off
    // would silently never reach a phone-only submission, which is exactly
    // the persona SMS-to-ticket (R-021) already exists to serve.
    category === 'prospect_prescreening' ||
    // R-059: the same reasoning - an application invite (own or a
    // co-applicant's) and a fee-paid confirmation are each a direct reply
    // to something the recipient just did, to a number they just gave.
    category === 'prospect_application' ||
    // R-064: same reasoning again, and the reminders are the entire point
    // of the category - a showing reminder that defaults off is a no-show
    // reduction feature nobody receives.
    category === 'prospect_showing'
  )
}

/**
 * What each category is called wherever it is named to a person.
 *
 * IN CORE RATHER THAN IN THE SETTINGS SCREEN, because R-097e needs the same
 * words in an email confirming an opt-out, and two copies of a vocabulary is
 * one copy that eventually stops matching - the same call
 * `LOCKED_CATEGORIES` made about its explanations, and for the same reason.
 *
 * Typed against the union, so the compiler refuses the next category added
 * without a label. CLAUDE.md's "adding a value to a status enum is never one
 * edit", caught by the type system instead of by somebody reading a screen.
 */
export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  rent_reminder: 'Rent reminders',
  payment_receipt: 'Payment receipts',
  payment_failed: 'Failed payments',
  autopay_predebit: 'Autopay pre-debit notice',
  legal_notice: 'Legal notices',
  entry_notice: 'Entry notices',
  maintenance_update: 'Maintenance updates',
  maintenance_emergency: 'Emergency maintenance',
  work_order_assigned: 'Work orders assigned to you',
  lease_renewal: 'Lease renewals',
  move_out: 'Move-out',
  lease_signature: 'Lease signing links',
  announcement: 'Announcements',
  approval_needed: 'Approvals waiting on you',
  task_assigned: 'Tasks assigned to you',
  unit_make_ready: 'Units ready to turn',
  compliance_due: 'Compliance dates coming up',
  vendor_response: 'Vendor replies on your jobs',
  digest_daily: 'Daily digest instead of one at a time (rent reminders, maintenance updates, renewals, announcements, ready units, compliance dates, your assigned tasks)',
  // Never actually shown on this screen in practice - the only recipient
  // this category ever sends to is PROSPECT, which has no staff account and
  // therefore no preferences row to read. Present so the exhaustive map
  // stays exhaustive rather than because anyone will see it.
  prospect_prescreening: 'Prospect pre-screening invites',
  prospect_application: 'Application invites and fee confirmations',
  prospect_showing: 'Showing bookings and reminders',
  inspection_signature: 'Inspection reports ready to review and sign',
  account_access: 'Sign-in and password links',
}

/**
 * Categories a failed delivery may NOT be re-sent for on its own (R-106).
 *
 * Serving a notice is a legally operative act. It starts a clock somebody is
 * counting days against, and a second copy of it arriving hours later carries
 * a second timestamp - so which service is the operative one becomes a
 * question a court asks and this system cannot answer. A retry sweep deciding
 * that on its own, at 3am, with nobody having chosen it, is the thing this
 * set exists to refuse.
 *
 * NOT the same list as LOCKED_CATEGORIES, and the difference is the point.
 * `maintenance_emergency` is locked BECAUSE it must reach somebody - a failed
 * gas-leak page is the one that most wants retrying. `lease_signature` is a
 * link to a page, re-sendable all day. Locked means "you may not switch this
 * off"; this means "we may not repeat it without you". Two different
 * questions that happen to share two members.
 *
 * What happens instead is not nothing: D-38's `serve_notice_offline` task is
 * raised, exactly as it is for a notice we could not text at all. The answer
 * to an undeliverable legal notice was already "put a human on it", and a
 * provider failure is the same fact arriving one step later.
 */
export const NEVER_AUTO_RETRY_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'legal_notice',
  'entry_notice',
])

export function mayAutoRetry(category: NotificationCategory): boolean {
  return !NEVER_AUTO_RETRY_CATEGORIES.has(category)
}
