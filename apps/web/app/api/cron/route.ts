import { auditAsSystem } from '@/lib/audit/index.ts'
import { isAuthorizedCron } from '@/lib/cron/authorize.ts'
import { dispatchOutbox } from '@/lib/jobs/outbox.ts'
// Side-effect import: populates SCHEDULED_JOBS before runDueJobs() reads it.
// See registrations.ts for why every job module is imported from exactly here.
import '@/lib/jobs/registrations.ts'
import { runDueJobs } from '@/lib/jobs/runner.ts'
import { reconcileLedger } from '@/lib/ledger/reconcile.ts'
import { storageIsDurable } from '@/lib/storage/index.ts'
import { sweepUnansweredTenantMessages } from '@/lib/comms/unanswered-sweep.ts'
import { sweepPendingDelists } from '@/lib/listings/delist-sweep.ts'
import { dispatchPendingNotifications } from '@/lib/notifications/send.ts'
import { sweepShowingReminders } from '@/lib/showings/reminders.ts'
import { sweepUnansweredDispatches } from '@/lib/vendors/no-response.ts'
import { sweepEntryReminders } from '@/lib/workorders/entry-reminders.ts'

// The single scheduled entry point. Vercel Cron hits it hourly (vercel.json),
// and the runner decides which properties are due in their own local time -
// D-3, restated: there is no UTC-midnight job in this product.
//
// Hourly rather than nightly on purpose. A nightly UTC job would have to pick
// one moment for a portfolio spanning several timezones, and would be wrong
// for all but one of them. Hourly ticks let each property's own 02:00 arrive
// whenever it arrives.

export const runtime = 'nodejs'
/// Never cached, never prerendered - it has side effects and reads a header.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    // 404, not 401. An unauthenticated caller learns nothing about whether
    // this endpoint exists, and a scanner gets no signal to come back.
    return new Response('Not found', { status: 404 })
  }

  const startedAt = Date.now()

  // Jobs first, then dispatch: a job that emits an event gets it delivered in
  // the same tick rather than waiting an hour for the next one. Notifications
  // last for the same reason - a consumer that decided one during the dispatch
  // above gets it sent now, not an hour from now, and this pass also picks up
  // whatever quiet hours deferred overnight (R-016).
  const runs = await runDueJobs()
  const dispatch = await dispatchOutbox()
  const notifications = await dispatchPendingNotifications()
  // Hourly rather than a SCHEDULED_JOBS entry, because it measures elapsed
  // hours since a dispatch rather than calendar days - see
  // lib/vendors/no-response.ts's own header for why that distinction puts it
  // here beside the other latency-driven sweeps (R-025).
  const vendorSilence = await sweepUnansweredDispatches()
  // T-1-day entry reminders (MAINT-05, R-027). Hourly for the same reason -
  // a fixed distance in hours from a scheduled instant, not a calendar-day
  // question, and "tomorrow" sent at 3am is not a reminder anybody reads.
  const entryReminders = await sweepEntryReminders()
  // T-1-day / T-2-hour showing reminders (LEASE-08, R-064). Same elapsed-
  // time reasoning as the entry reminders above.
  const showingReminders = await sweepShowingReminders()
  // COMM-07: "unanswered tenant messages past X days surface on the
  // dashboard." Elapsed-time, not a calendar-day question, for the same
  // reason as the sweeps above.
  const unanswered = await sweepUnansweredTenantMessages()
  // LEASE-02's "≤24h delist on lease-up" (R-057, D-7). Reconciles the
  // network side of a listing delist-consumer.ts already applied locally -
  // never inside that consumer's own transaction, see delist-sweep.ts's
  // own header for why.
  const delisting = await sweepPendingDelists()
  // The ledger projection, checked against the event log that produced it
  // (D-11, R-035). Hourly rather than a SCHEDULED_JOBS entry for the same
  // reason as the sweeps above: it is not a per-property calendar-day
  // question, it is one comparison over recent rows. "A projection nobody
  // checks is a lie with a timestamp."
  const reconciliation = await reconcileLedger()

  const ran = runs.filter((r) => r.outcome === 'ran')
  const failures = runs.filter((r) => r.outcome === 'failed')

  if (failures.length > 0) {
    // Recorded rather than logged: a nightly job that failed silently is how a
    // month of missing late fees happens. AuditLog is append-only, so this is
    // still there when someone finally asks.
    await auditAsSystem('cron', {
      action: 'job.failed',
      entityType: 'JobRun',
      entityId: 'cron',
      after: { failures },
    }).catch(() => {
      // An audit failure must not swallow the response the cron needs to see.
    })
  }

  return Response.json({
    ok: failures.length === 0,
    ranJobs: ran.length,
    failedJobs: failures.length,
    notDue: runs.filter((r) => r.outcome === 'not_due').length,
    alreadyRan: runs.filter((r) => r.outcome === 'already_ran').length,
    eventsPublished: dispatch.published,
    eventsFailed: dispatch.failed,
    notificationsSent: notifications.sent,
    notificationsFailed: notifications.failed,
    // R-102: what the tick could NOT get to. Non-zero here on consecutive
    // ticks means the hourly batch is smaller than the arrival rate, which
    // no other number on this response would show.
    notificationsRemaining: notifications.remaining,
    vendorSilenceChecked: vendorSilence.checked,
    vendorSilencePrompted: vendorSilence.prompted,
    entryRemindersChecked: entryReminders.checked,
    entryRemindersSent: entryReminders.reminded,
    showingRemindersChecked: showingReminders.checked,
    showingRemindersSent: showingReminders.reminded,
    unansweredChecked: unanswered.checked,
    unansweredFlagged: unanswered.flagged,
    delistingChecked: delisting.checked,
    delistingDelisted: delisting.delisted,
    delistingFailed: delisting.failed,
    ledgerEventsChecked: reconciliation.checkedEvents,
    ledgerEntriesChecked: reconciliation.checkedEntries,
    ledgerDrift: reconciliation.drift.length,
    // R-100: false in a deployed environment means uploads are being written
    // to a filesystem that does not survive the request. Reported here
    // because a silent reversion to local disk - a detached Blob store, a
    // dropped env var - looks exactly like everything working until somebody
    // opens a photo months later and it is gone.
    storageDurable: storageIsDurable,
    durationMs: Date.now() - startedAt,
  })
}
