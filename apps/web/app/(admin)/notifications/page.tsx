import { friendlyTimestamp } from '@rental/core/scheduling'
import { requireScope } from '@/lib/auth/guard.ts'
import { listNotifications } from '@/lib/notifications/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Notifications — Rental Operations' }

// The central send log (NOTIF-01: "all attempts/failures/retries logged
// centrally"). Read-only by construction - Notification is append-only at the
// database level, so there is nothing here to edit even in principle.
//
// This screen exists to answer one question quickly: "did they get it, and if
// not, why not?" A suppressed row with its reason answers it better than an
// absent row ever could, which is why suppressed sends are recorded at all.

const STATUS_LABELS: Record<string, string> = {
  QUEUED: 'Queued',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  SUPPRESSED: 'Not sent',
  DEFERRED: 'Held for quiet hours',
}

const SUPPRESSION_LABELS: Record<string, string> = {
  preference_off: 'recipient turned this category off',
  no_address: 'no address on file',
  kill_switch: 'sending is switched off',
  unsupported_channel: 'no provider for this channel',
}

const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  PORTAL: 'Portal',
  CALL_LOG: 'Call log',
}

function statusClasses(status: string): string {
  if (status === 'FAILED' || status === 'BOUNCED') {
    return 'bg-red-100 text-red-900'
  }
  if (status === 'SUPPRESSED' || status === 'DEFERRED') {
    return 'bg-amber-100 text-amber-900'
  }
  if (status === 'QUEUED') {
    return 'bg-muted text-muted-foreground'
  }
  return 'bg-emerald-100 text-emerald-900'
}

export default async function NotificationsPage() {
  // requireScope, not a bare requirePermission('message.read') - a
  // property-scoped manager holds message.read only over their own property,
  // and a resource-less check would deny them this page entirely rather than
  // letting the scoped query decide which rows they see.
  const { actor } = await requireScope('message.read')
  const scope = await currentScope(actor)
  const notifications = await listNotifications(scope)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground text-sm">
          Every message this system decided to send, including the ones it
          deliberately did not. Append-only.
        </p>
      </header>

      {notifications.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing sent yet for the properties you can see.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {notifications.map((notification) => {
            const status = notification.delivery?.status ?? 'QUEUED'
            const reason = notification.delivery?.suppressedReason
            return (
              <li
                key={notification.id}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {notification.subject ?? notification.category}
                  </span>
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs font-medium ${statusClasses(status)}`}
                  >
                    {STATUS_LABELS[status] ?? status}
                    {reason ? ` — ${SUPPRESSION_LABELS[reason] ?? reason}` : ''}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {CHANNEL_LABELS[notification.channel] ?? notification.channel}{' '}
                  to {notification.toAddress}
                  {notification.property ? ` · ${notification.property.name}` : ''}
                  {' · '}
                  {friendlyTimestamp(
                    notification.createdAt,
                    // A notification with no property is a portfolio-wide one
                    // (a digest, an account email); UTC is then the honest
                    // answer rather than a guess, and `friendlyTimestamp`
                    // prints the abbreviation so it says which it is.
                    notification.property?.timezone ?? 'UTC',
                  )}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
