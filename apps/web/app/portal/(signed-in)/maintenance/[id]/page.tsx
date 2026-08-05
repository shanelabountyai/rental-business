import { CATEGORY_LABELS } from '@rental/core/maintenance'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AddPhotoForm } from '@/components/portal/maintenance/add-photo-form.tsx'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { getTenantTicket } from '@/lib/maintenance/queries.ts'

export const metadata = { title: 'Maintenance request' }

const STATUS_WORDS: Record<string, string> = {
  NEW: 'Just sent',
  TRIAGED: "We've seen this",
  WAITING_ON_TENANT: 'Waiting to hear back from you',
  CONVERTED: 'Work scheduled',
  MERGED: 'Combined with another request',
  CLOSED: 'Resolved',
}

export default async function MaintenanceTicketPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { scope } = await requireTenantWithScope()

  const ticket = await getTenantTicket(id, scope)
  // Not yours and does not exist are indistinguishable - see DOC-03's
  // identical reasoning in lib/portal/queries.ts.
  if (!ticket) notFound()

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/portal/maintenance"
        className="focus-visible:ring-ring w-fit rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← All requests
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ??
            ticket.category}
        </h1>
        <p className="text-muted-foreground">
          {STATUS_WORDS[ticket.status] ?? ticket.status}
        </p>
      </div>

      <p className="whitespace-pre-wrap rounded-md border p-4">{ticket.description}</p>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Photos</h2>
        {ticket.documents.length === 0 ? (
          <p>No photos yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ticket.documents.map((document) => (
              <li key={document.id}>
                <a
                  href={`/api/documents/${document.id}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-3 py-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  {document.fileName}
                </a>
              </li>
            ))}
          </ul>
        )}
        <AddPhotoForm ticketId={ticket.id} />
      </div>
    </div>
  )
}
