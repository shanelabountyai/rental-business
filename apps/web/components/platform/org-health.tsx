import { friendlyTimestamp } from '@rental/core/scheduling'
import { healthIsStale } from '@/lib/platform/orgs.ts'

type Health = {
  computedAt: Date
  dailyAt: Date | null
  dailyOk: boolean | null
  notificationsAt: Date | null
  notificationsOk: boolean | null
  escalationsAt: Date | null
  escalationsOk: boolean | null
  failedRuns7d: number
  deadLetters: number
  queuedNotifications: number
  heldNotifications: number
}

const when = (at: Date) => friendlyTimestamp(at, 'UTC')

export function runOutcome(at: Date | null, ok: boolean | null): string {
  if (!at) return 'never reported'
  return `${ok ? 'succeeded' : 'failed'} ${when(at)}`
}

/**
 * PRD 11 §4.2: a figure older than 26 hours is replaced by when it was last
 * reported, so a dead cron cannot pass for a healthy org.
 */
export function HealthFreshness({ health, now }: { health: { computedAt: Date } | null; now: Date }) {
  if (!health) return <span>Health not yet reported</span>
  if (healthIsStale(health, now)) return <span>Health not reported since {when(health.computedAt)}</span>
  return <span>Health as of {when(health.computedAt)}</span>
}

export function OrgHealthPanel({ health, now }: { health: Health | null; now: Date }) {
  return (
    <section aria-labelledby="health-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
      <h2 id="health-heading" className="text-lg font-semibold">
        Health
      </h2>
      <p className="text-muted-foreground">
        <HealthFreshness health={health} now={now} />
      </p>
      {health && !healthIsStale(health, now) && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 break-words sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Daily run</dt>
          <dd>{runOutcome(health.dailyAt, health.dailyOk)}</dd>
          <dt className="font-medium">Notification run</dt>
          <dd>{runOutcome(health.notificationsAt, health.notificationsOk)}</dd>
          <dt className="font-medium">Escalation run</dt>
          <dd>{runOutcome(health.escalationsAt, health.escalationsOk)}</dd>
          <dt className="font-medium">Failed runs, last 7 days</dt>
          <dd>{health.failedRuns7d}</dd>
          <dt className="font-medium">Dead-lettered events</dt>
          <dd>{health.deadLetters}</dd>
          <dt className="font-medium">Queued notifications</dt>
          <dd>{health.queuedNotifications}</dd>
          <dt className="font-medium">Held for quiet hours</dt>
          <dd>{health.heldNotifications}</dd>
        </dl>
      )}
    </section>
  )
}
