import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { propertyWhere, requireScope } from '@/lib/auth/guard.ts'
import { resendFailedAnnouncement } from '@/lib/comms/announcement-actions.ts'
import {
  RESENDABLE_STATUSES,
  announcementDeliveries,
  announcementHistory,
} from '@/lib/comms/announcement-history.ts'
import { friendlyWallClock } from '@/lib/comms/announcements.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Announcement history' }

// R-054, left behind by R-053: "persistent announcement history beyond the
// immediate per-send result table." See announcement-history.ts for why this
// reads AuditLog rather than a new table, and why it's portfolio-wide only.

export default async function AnnouncementHistoryPage() {
  const { scope } = await requireScope('message.send')
  const entries = await announcementHistory(scope)
  // R-262: per-recipient status is read LIVE off NotificationDelivery, not
  // off the audit row - a Twilio callback a day later changes it, and the
  // audit row is append-only and must not try to follow.
  const deliveries = await announcementDeliveries(entries ?? [])

  const staffIds = [
    ...new Set((entries ?? []).map((e) => e.sentByStaffId).filter((id): id is string => !!id)),
  ]
  const staff = staffIds.length
    ? await prisma.staffUser.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, name: true },
      })
    : []
  const staffNames = new Map(staff.map((s) => [s.id, s.name]))

  // A NAMED ZONE, because `toLocaleString()` with no arguments used the
  // server's - UTC on Vercel - and said so nowhere (R-115). An announcement is
  // portfolio-wide and hangs off no single property, so there is no perfectly
  // right zone; the first property in scope is the closest available answer
  // and `friendlyTimestamp` prints the abbreviation beside it, which is what
  // makes the choice legible rather than a second silent guess.
  const zone =
    (
      await prisma.property.findFirst({
        where: propertyWhere(scope) ?? { id: '' },
        orderBy: { name: 'asc' },
        select: { timezone: true },
      })
    )?.timezone ?? 'UTC'

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages/announcements"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Announcements
        </Link>
        <PageHeader title="Announcement history" />
        <p className="text-muted-foreground text-sm">
          Every segment announcement ever sent, scheduled or cancelled, from
          the audit log each one writes.
        </p>
      </header>

      {entries === null ? (
        <p className="text-muted-foreground text-sm">
          Announcement history is portfolio-wide. Ask an owner to view it.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">No announcements sent yet.</p>
      ) : (
        <div
          className="overflow-x-auto rounded-md border"
          {...scrollableRegionProps('Announcements sent, scrolls sideways')}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Template
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Segment
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Sent by
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Sent / requested
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Skipped
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Recipients
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {friendlyTimestamp(entry.occurredAt, zone)}
                  </td>
                  <td className="px-3 py-2">
                    {entry.kind === 'scheduled' && 'Scheduled: '}
                    {entry.kind === 'cancelled' && 'Cancelled: '}
                    {entry.kind === 'resent' && 'Resent to failed: '}
                    {entry.templateName ?? '—'}
                    {entry.sendAt ? ` (for ${friendlyWallClock(entry.sendAt)})` : ''}
                  </td>
                  <td className="px-3 py-2">
                    {entry.segmentType ?? '—'}
                    {entry.segmentValue ? `: ${entry.segmentValue}` : ''}
                  </td>
                  <td className="px-3 py-2">
                    {entry.sentByStaffId ? (staffNames.get(entry.sentByStaffId) ?? '—') : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.sent ?? '—'} / {entry.requested ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {entry.skippedCount ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <RecipientStatus
                      entry={entry}
                      deliveries={deliveries.get(entry.id) ?? []}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/// R-262: what happened to each recipient, as it stands now, and the resend.
/// A native <details> - it works before hydration and needs no state. A row
/// written before R-262 recorded no delivery ids and says so.
function RecipientStatus({
  entry,
  deliveries,
}: {
  entry: { id: string; kind: string; templateName: string | null; deliveryIds: string[] }
  deliveries: { id: string; tenantName: string; channel: string; status: string; reason: string | null }[]
}) {
  if (entry.kind === 'cancelled') return <span className="text-muted-foreground">—</span>
  if (deliveries.length === 0) {
    return <span className="text-muted-foreground">Not recorded for this send</span>
  }
  const failed = deliveries.filter((d) => RESENDABLE_STATUSES.includes(d.status))
  // Recipients, not rows: every tenant has one row per channel, most of them
  // SUPPRESSED, and "6 deliveries" for two tenants reads as a wrong count.
  const recipients = new Set(deliveries.map((d) => d.tenantName)).size
  const label = `${recipients} ${recipients === 1 ? 'recipient' : 'recipients'}${
    failed.length ? `, ${failed.length} failed` : ''
  }`
  return (
    <details>
      <summary className="focus-visible:ring-ring cursor-pointer py-2 underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none">
        {label}
      </summary>
      <ul className="flex flex-col gap-1 py-2">
        {deliveries.map((d) => (
          <li key={d.id} className="whitespace-nowrap">
            {d.tenantName} · {d.channel}: {d.status.toLowerCase()}
            {d.reason ? ` (${d.reason})` : ''}
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <form action={resendFailedAnnouncement}>
          <input type="hidden" name="auditLogId" value={entry.id} />
          <button
            type="submit"
            aria-label={`Resend to ${failed.length} failed: ${entry.templateName ?? 'announcement'}`}
            className="focus-visible:ring-ring min-h-11 rounded-md px-3 text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            Resend to {failed.length} failed
          </button>
        </form>
      )}
    </details>
  )
}
