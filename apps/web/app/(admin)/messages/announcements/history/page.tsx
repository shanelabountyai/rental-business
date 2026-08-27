import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { propertyWhere, requireScope } from '@/lib/auth/guard.ts'
import { announcementHistory } from '@/lib/comms/announcement-history.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Announcement history — Rental Operations' }

// R-054, left behind by R-053: "persistent announcement history beyond the
// immediate per-send result table." See announcement-history.ts for why this
// reads AuditLog rather than a new table, and why it's portfolio-wide only.

export default async function AnnouncementHistoryPage() {
  const { scope } = await requireScope('message.send')
  const entries = await announcementHistory(scope)

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
        <h1 className="text-2xl font-semibold tracking-tight">Announcement history</h1>
        <p className="text-muted-foreground text-sm">
          Every segment announcement ever sent, from the audit log each send
          already writes.
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
                  Sent
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
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {friendlyTimestamp(entry.occurredAt, zone)}
                  </td>
                  <td className="px-3 py-2">{entry.templateName ?? '—'}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
