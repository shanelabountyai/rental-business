import Link from 'next/link'
import { AnnouncementForm } from '@/components/messages/announcement-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { sendAnnouncement } from '@/lib/comms/announcement-actions.ts'
import { segmentOptions } from '@/lib/comms/announcements.ts'
import { listTemplates } from '@/lib/comms/templates.ts'

export const metadata = { title: 'Announcements — Rental Operations' }

// Segment announcements (COMM-04, R-053) — "the city is flushing hydrants
// Tuesday". `requireScope`, not a bare `requirePermission`: a property-scoped
// manager holds message.send over their own properties only, and the segment
// itself is resolved against that same scope inside the action.

export default async function AnnouncementsPage() {
  const { scope } = await requireScope('message.send')

  const [options, templates] = await Promise.all([segmentOptions(scope), listTemplates()])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Messages
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Announcements</h1>
        <p className="text-muted-foreground text-sm">
          One message to a whole segment — all tenants, one property, one
          metro, or one tag — with delivery status for every recipient.
        </p>
      </header>

      <div className="flex gap-4">
        {templates.length === 0 && (
          <Link href="/messages/templates/new" className="text-sm underline underline-offset-4">
            Write a template
          </Link>
        )}
        <Link href="/messages/announcements/history" className="text-sm underline underline-offset-4">
          History
        </Link>
      </div>

      <AnnouncementForm
        options={options}
        templates={templates.map((template) => ({ id: template.id, name: template.name }))}
        // Not bound — sendAnnouncement takes only (state, formData), the
        // 'use server' export itself, which is the only kind of function the
        // client can call back to.
        sendAction={sendAnnouncement}
      />
    </div>
  )
}
