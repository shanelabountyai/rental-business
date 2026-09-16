import { friendlyTimestamp } from '@rental/core/scheduling'
import type { ChannelOutcome } from '@/lib/notifications/send.ts'
import type { SuppressionReason } from '@rental/core/notifications'

/**
 * WHAT ACTUALLY HAPPENED TO ONE RECIPIENT'S MESSAGE (R-211).
 *
 * `notify()` has always returned this - `status`, `reason`, `sendAfter` - and
 * for thirty-nine callers three read it. The other thirty-six pushed a name
 * onto a "sent" list the moment the call returned, so the append-only
 * `Notification` row said SUPPRESSED while the screen and the audit row said
 * sent: two contradictory records of one event, and the wrong one is the one
 * a PM or an attorney reads.
 *
 * ONE DECISION FUNCTION, not a sentence builder. The four callers that make a
 * claim to the operator each phrase it differently ("Reminder sent to 3
 * people", "the tenant has been told", "on its way to Plan Tenant", "Link
 * sent to Ace Plumbing") and a generic sentence would be worse copy than any
 * of them. What they must not each re-derive is the RULE.
 */
export type ReachStatus = 'SENT' | 'ALREADY_SENT' | 'DEFERRED' | 'NOT_SENT'

export interface Reach {
  status: ReachStatus
  /// DEFERRED only, and only when the engine recorded a time. Property-local
  /// formatting is the caller's job - core must not guess a zone (D-3).
  sendAfter?: Date | null
  /// NOT_SENT only: the distinct reasons, in plain English, joined.
  why?: string
}

/**
 * Operator-facing clauses, deliberately SHORTER than
 * `packages/core/comms/record.ts`'s `SUPPRESSION_NARRATIVE`, which is written
 * for a transcript an adjuster or a judge reads. These land in a toast next
 * to a count. Two maps rather than one because the audiences genuinely
 * differ - and both are `Record<SuppressionReason, string>`, so an eighth
 * reason fails to compile in both places rather than going unexplained in
 * one.
 */
const NOT_SENT_BECAUSE: Record<SuppressionReason, string> = {
  no_address: 'no email or phone we may use',
  no_consent: 'no consent to text them on file',
  sms_opt_out: 'their carrier reported a STOP',
  preference_off: 'they turned this kind of message off',
  kill_switch: 'sending is switched off system-wide',
  unsupported_channel: 'no channel that can carry this message',
  // Unreachable: `digest_batched` is counted as reaching them - see below.
  digest_batched: 'folded into their daily digest instead',
}

/**
 * QUEUED beats already-sent beats DEFERRED beats suppressed. R-207's
 * `vendorDispatchNotice` set that order and this generalises it: if any
 * channel is going now the message is on its way and the rest is detail.
 *
 * PORTAL IS NOT REACHING SOMEBODY. A portal row waits behind a sign-in the
 * recipient may not be able to complete at all - R-173's phone-only tenant
 * gets a live PORTAL row and cannot log in, which is the whole of R-216. It
 * is evidence the message exists, never evidence it arrived, so it is
 * excluded here exactly as `plan-actions.ts` already excluded it by hand.
 *
 * `digest_batched` COUNTS AS SENT, and that is a deliberate call. The
 * recipient asked for this category batched into one email that day, so the
 * message does reach them and the operator has nothing to do; reporting it
 * as not-sent would make a PM re-send by hand and double-message the tenant,
 * which is the opposite lie and the worse one. `rent_reminder` is
 * digest-eligible, so this is live for the chase, not theoretical.
 */
export function reachOf(outcomes: readonly ChannelOutcome[]): Reach {
  const real = outcomes.filter((outcome) => outcome.channel !== 'PORTAL')

  if (
    real.some(
      (outcome) =>
        outcome.status === 'QUEUED' ||
        (outcome.status === 'SUPPRESSED' && outcome.reason === 'digest_batched'),
    )
  ) {
    return { status: 'SENT' }
  }

  // A `duplicate` carries no status at all: some earlier call already decided
  // this exact (key, channel). Neither a new send nor a failure - and R-207's
  // version fell through to "Not sent", which was wrong in the one direction
  // that matters, because the link had in fact gone.
  if (real.some((outcome) => outcome.outcome === 'duplicate')) {
    return { status: 'ALREADY_SENT' }
  }

  const deferred = real.filter((outcome) => outcome.status === 'DEFERRED')
  if (deferred.length > 0) {
    // The EARLIEST, so a caller that names the hour names the one the
    // recipient actually hears at.
    const sendAfter = deferred
      .map((outcome) => outcome.sendAfter)
      .filter((at): at is Date => at != null)
      .sort((a, b) => a.getTime() - b.getTime())[0]
    return { status: 'DEFERRED', sendAfter: sendAfter ?? null }
  }

  const reasons = [
    ...new Set(
      real.map((outcome) =>
        outcome.reason
          ? NOT_SENT_BECAUSE[outcome.reason]
          : // An unrecorded reason prints as unfinished rather than as a
            // friendly guess, the same rule `deliveryNarrative` follows.
            'the reason was not recorded',
      ),
    ),
  ]
  return {
    status: 'NOT_SENT',
    why: reasons.length > 0 ? reasons.join('; ') : 'no channel reaches this recipient',
  }
}

/**
 * The entry-notice half of "Scheduled." - shared because
 * `workorders/scheduling.ts` and `inspections/scheduling.ts` carried the
 * identical sentence, *"Scheduled, and the tenant has been told."*, returned
 * unconditionally and even when the notify call had thrown.
 *
 * An entry notice is the one message a tenant is statutorily owed, so the
 * unsent case tells the operator to serve it themselves rather than merely
 * reporting a gap (D-38's reasoning, one screen earlier).
 */
export function entryNoticeClause(reach: Reach, timezone: string): string {
  switch (reach.status) {
    case 'SENT':
      return 'and the tenant has been told'
    case 'ALREADY_SENT':
      return 'and the tenant had already been told about this window'
    case 'DEFERRED':
      return reach.sendAfter
        ? `and the tenant is told at ${friendlyTimestamp(reach.sendAfter, timezone)} - quiet hours at this property`
        : 'and the tenant is told once quiet hours end at this property'
    case 'NOT_SENT':
      return `but THE TENANT HAS NOT BEEN TOLD - ${reach.why}. Serve the notice yourself before the visit`
  }
}
