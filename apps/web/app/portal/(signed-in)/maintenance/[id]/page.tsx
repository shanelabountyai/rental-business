import { CATEGORY_LABELS, emergencyDefinition } from '@rental/core/maintenance'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AddPhotoForm } from '@/components/portal/maintenance/add-photo-form.tsx'
import { VerifyPanel } from '@/components/portal/maintenance/verify-panel.tsx'
import { verifyWorkOrder } from '@/lib/portal/verify-actions.ts'
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
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ emergency?: string }>
}) {
  const [{ id }, { emergency }] = await Promise.all([params, searchParams])
  const { scope } = await requireTenantWithScope()

  const ticket = await getTenantTicket(id, scope)
  // Not yours and does not exist are indistinguishable - see DOC-03's
  // identical reasoning in lib/portal/queries.ts.
  if (!ticket) notFound()

  // The job this tenant is being asked about, or has just answered.
  //
  // Both states render the same component. Asking about a job they have
  // already answered for THIS round would be nagging - but dropping the
  // panel the instant they answer is worse: the page re-renders on
  // `revalidatePath` before any client-side confirmation could appear, so
  // the tenant would tap, watch the question vanish, and have no idea
  // whether it worked. The answer stays on screen until the job comes back
  // finished and there is a genuinely new question to ask.
  const verifiable = ticket.workOrders.find(
    (workOrder) =>
      workOrder.status !== 'CLOSED' &&
      workOrder.status !== 'CANCELED' &&
      (workOrder.status === 'WORK_COMPLETE' || workOrder.verifications.length > 0),
  )
  const latest = verifiable?.verifications[0]
  // A fresh ask exists only when the job is back at WORK_COMPLETE for a
  // round nobody has answered.
  const askingAgain =
    verifiable?.status === 'WORK_COMPLETE' &&
    latest?.round !== verifiable.reopenCount + 1
  const answered = !askingAgain && latest ? { resolved: latest.resolved } : null

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/portal/maintenance"
        className="focus-visible:ring-ring w-fit rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← All requests
      </Link>

      {verifiable && (
        <VerifyPanel
          workOrderId={verifiable.id}
          answered={answered}
          verify={verifyWorkOrder}
        />
      )}

      {/*
        Shown once, on arrival from the emergency flow. The reassurance a
        tenant needs at 2am is not "your request has been logged" - it is
        that a person is being woken up, and that they can still reach one
        directly if nobody calls back.
      */}
      {emergency === '1' && (
        <p
          role="status"
          className="rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 font-medium text-red-950 dark:bg-red-950 dark:text-red-50"
        >
          We have paged someone now. If this is life-threatening, call 911. If
          you do not hear back shortly, call or text the number on your lease.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {emergencyDefinition(ticket.category)?.label ??
            CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ??
            'What you texted us'}
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
