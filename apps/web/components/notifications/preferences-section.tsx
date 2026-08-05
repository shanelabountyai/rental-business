import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@rental/core/notifications'
import { PreferenceToggle } from '@/components/notifications/preference-toggle.tsx'
import { setNotificationPreference } from '@/lib/notifications/actions.ts'
import type { PreferenceRow } from '@/lib/notifications/queries.ts'

// NOTIF-02: "Per-category channel preferences per user; legally-critical
// categories (legal notices, emergency maintenance) locked on with
// explanation."
//
// The explanation is the part that is easy to skip and shouldn't be. A locked
// toggle with no reason reads as a bug or as high-handedness; the same toggle
// with "turning this off could invalidate a notice you are entitled to
// receive" reads as the product looking after them. The text comes from
// packages/core/notifications so it is the same wherever the question is
// asked.

const CATEGORY_LABELS: Record<string, string> = {
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
  approval_needed: 'Approvals waiting on you',
  task_assigned: 'Tasks assigned to you',
  unit_make_ready: 'Units ready to turn',
  compliance_due: 'Compliance dates coming up',
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  PORTAL: 'Portal',
}

export function NotificationPreferencesSection({
  preferences,
}: {
  preferences: PreferenceRow[]
}) {
  const byCategory = new Map<string, PreferenceRow[]>()
  for (const row of preferences) {
    const rows = byCategory.get(row.category) ?? []
    rows.push(row)
    byCategory.set(row.category, rows)
  }

  return (
    <section aria-labelledby="notifications" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="notifications" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="text-muted-foreground text-sm">
          Changes save as you make them. Quiet hours (9pm–8am at the property)
          hold everything except emergencies until morning.
        </p>
      </div>

      <ul className="flex flex-col divide-y rounded-md border">
        {[...byCategory.entries()].map(([category, rows]) => {
          const locked = rows[0]?.locked ?? false
          return (
            <li key={category} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                {locked && rows[0]?.lockedExplanation && (
                  <p className="text-muted-foreground text-xs">
                    Always on. {rows[0].lockedExplanation}
                  </p>
                )}
              </div>
              {!locked && (
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {NOTIFICATION_CHANNELS.map((channel) => {
                    const row = rows.find((r) => r.channel === channel)
                    if (!row) return null
                    return (
                      <PreferenceToggle
                        key={channel}
                        category={category}
                        channel={channel}
                        label={CHANNEL_LABELS[channel]}
                        enabled={row.enabled}
                        action={setNotificationPreference}
                      />
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
