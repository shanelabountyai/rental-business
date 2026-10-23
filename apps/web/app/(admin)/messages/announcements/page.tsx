import Link from 'next/link'
import { parseSegment } from '@rental/core/comms'
import {
  AnnouncementForm,
  AnnouncementPreviewPanel,
  SaveAudienceForm,
} from '@/components/messages/announcement-form.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { INPUT_CLASSES, PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import {
  cancelScheduledAnnouncement,
  retireAudience,
  saveAudience,
  sendAnnouncement,
} from '@/lib/comms/announcement-actions.ts'
import { previewAnnouncement } from '@/lib/comms/announcement-preview.ts'
import {
  friendlyWallClock,
  listAudiences,
  listScheduledAnnouncements,
  reviewSegment,
  segmentOptions,
} from '@/lib/comms/announcements.ts'
import { getTemplate, listTemplates } from '@/lib/comms/templates.ts'

export const metadata = { title: 'Announcements — Rental Operations' }

// Segment announcements (COMM-04, R-053) — "the city is flushing hydrants
// Tuesday". `requireScope`, not a bare `requirePermission`: a property-scoped
// manager holds message.send over their own properties only, and the segment
// itself is resolved against that same scope inside the action.
//
// TWO STEPS, BOTH SERVER-RENDERED (R-259). Choosing who it goes to is a plain
// GET form, so `?segment=` is the whole state of step one and it works before
// hydration (R-115's reason for one select). Step two is the reviewed list
// the send posts back. One `<select>` with the count in every option: a
// second, conditionally-rendered control would only exist after hydration,
// which is the bug R-115 removed.

function withCount(choice: { label: string; count: number }): string {
  return `${choice.label} — ${choice.count} ${choice.count === 1 ? 'tenant' : 'tenants'}`
}

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ segment?: string; templateId?: string }>
}) {
  const { actor, scope } = await requireScope('message.send')
  const { segment: posted = '', templateId = '' } = await searchParams
  const segment = parseSegment(posted)

  const [options, templates, audiences, scheduled, recipients] = await Promise.all([
    segmentOptions(scope),
    listTemplates(actor.orgId),
    listAudiences(actor.orgId),
    listScheduledAnnouncements(scope, actor.id),
    segment ? reviewSegment(scope, segment) : Promise.resolve(null),
  ])
  // The preview needs the template, so it is chosen in step one beside the
  // segment (R-260). An id that is gone or retired previews nothing.
  const chosen = templateId ? templates.find((t) => t.id === templateId) ?? null : null
  const template = chosen ? await getTemplate(chosen.id, actor.orgId) : null
  const preview =
    template && recipients && recipients.length > 0
      ? await previewAnnouncement(template, recipients.map((r) => r.leaseId), actor.orgId)
      : null
  const groups = options.groups.filter((group) => group.choices.length > 0)
  const segmentLabels = new Map<string, string>([
    [options.all.value, options.all.label],
    ...options.groups.flatMap((g) => g.choices.map((c) => [c.value, c.label] as [string, string])),
  ])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Messages
        </Link>
        <PageHeader title="Announcements" />
        <p className="text-muted-foreground text-sm">
          One message to a whole segment — all tenants, one entity, property,
          unit, metro or tag, or everyone with a balance due, an open repair,
          or a move-in or move-out coming up — with delivery status for every
          recipient.
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

      <form method="get" className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Send an announcement</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="segment" className="text-sm font-medium">
            Send to
          </label>
          <select
            id="segment"
            name="segment"
            defaultValue={segment ? posted : 'ALL'}
            aria-describedby="segment-hint"
            // INPUT_CLASSES for its `min-w-0 max-w-full` (R-170a): a native
            // select is as wide as its widest option, and "Property · Unit"
            // labels (R-258) are the longest this one has carried.
            className={INPUT_CLASSES}
          >
            <option value={options.all.value}>{withCount(options.all)}</option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.choices.map((choice) => (
                  <option key={`${group.label}:${choice.value}`} value={choice.value}>
                    {withCount(choice)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p id="segment-hint" className="text-muted-foreground text-sm">
            Counts are current tenancies. A lease on a marketing hold, or a
            tenant whose merge fields cannot be filled, is dropped at send time
            and named in the results.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="templateId" className="text-sm font-medium">
            Message
          </label>
          <select
            id="templateId"
            name="templateId"
            defaultValue={chosen?.id ?? ''}
            required
            className={INPUT_CLASSES}
          >
            <option value="" disabled>
              Choose a template…
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={`${PRIMARY_BUTTON_CLASSES} self-start`}>
          Choose recipients
        </button>
      </form>

      {segment && recipients && recipients.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm">
          Nobody matches that segment right now. Choose another one above.
        </p>
      )}

      {segment && recipients && recipients.length > 0 && !template && (
        <p className="rounded-lg border border-dashed p-4 text-sm">
          Choose a message above to see a preview and send.
        </p>
      )}

      {preview && <AnnouncementPreviewPanel preview={preview} />}

      {segment && recipients && recipients.length > 0 && template && (
        <>
          <AnnouncementForm
            // Keyed on the segment so a new choice starts fully ticked again.
            key={`${posted}:${template.id}`}
            segment={posted}
            templateId={template.id}
            recipients={recipients}
            // Not bound — sendAnnouncement takes only (state, formData), the
            // 'use server' export itself, which is the only kind of function
            // the client can call back to.
            sendAction={sendAnnouncement}
          />
          <SaveAudienceForm segment={posted} saveAction={saveAudience} />
        </>
      )}

      {scheduled.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Scheduled</h2>
          <ul className="flex flex-col">
            {scheduled.map((s) => (
              <li
                key={s.id}
                className="flex min-h-11 min-w-0 items-center justify-between gap-3 border-b break-words last:border-0"
              >
                <span className="flex min-w-0 flex-col py-1.5 text-sm">
                  <span className="font-medium">
                    {s.template.name} · {friendlyWallClock(s.sendAt)}
                  </span>
                  <span className="text-muted-foreground">
                    {segmentLabels.get(s.segment) ?? s.segment} · {s.recipientCount}{' '}
                    {s.recipientCount === 1 ? 'tenant' : 'tenants'} · by {s.createdBy.name}
                  </span>
                </span>
                <form action={cancelScheduledAnnouncement}>
                  <input type="hidden" name="scheduleId" value={s.id} />
                  <button
                    type="submit"
                    aria-label={`Cancel scheduled announcement ${s.template.name}`}
                    className="focus-visible:ring-ring min-h-11 rounded-md px-3 text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Cancel
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {audiences.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Saved audiences</h2>
          <ul className="flex flex-col">
            {audiences.map((audience) => (
              <li
                key={audience.id}
                className="flex min-h-11 min-w-0 items-center justify-between gap-3 border-b break-words last:border-0"
              >
                <span className="min-w-0 text-sm">{audience.name}</span>
                <form action={retireAudience}>
                  <input type="hidden" name="audienceId" value={audience.id} />
                  <button
                    type="submit"
                    aria-label={`Remove saved audience ${audience.name}`}
                    className="focus-visible:ring-ring min-h-11 rounded-md px-3 text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
