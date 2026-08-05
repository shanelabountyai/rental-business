import { CATEGORY_LABELS, emergencyDefinition } from '@rental/core/maintenance'
import Link from 'next/link'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { listTenantTickets } from '@/lib/maintenance/queries.ts'

export const metadata = { title: 'Maintenance' }

// MAINT-01's entry point: report a problem, and see what you have already
// reported. Ticket.status is staff/triage vocabulary (NEW, TRIAGED,
// WAITING_ON_TENANT, ...) - D-10's lexicon governs the tenant-facing words,
// which are not a 1:1 relabeling of the enum but what a tenant would
// actually want to know: has anyone seen this yet, and is it done.

const STATUS_WORDS: Record<string, string> = {
  NEW: 'Just sent',
  TRIAGED: "We've seen this",
  WAITING_ON_TENANT: 'Waiting to hear back from you',
  CONVERTED: 'Work scheduled',
  MERGED: 'Combined with another request',
  CLOSED: 'Resolved',
}

function friendlyDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(value)
}

export default async function PortalMaintenancePage() {
  const { scope } = await requireTenantWithScope()
  const tickets = await listTenantTickets(scope)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <p>Report a problem, or check on one you already sent.</p>
      </div>

      {/*
        The emergency route is first and visually distinct - somebody who can
        smell gas must not have to read past "Report a problem" to find it.
        MAINT-01's emergency criterion is a safety requirement, and the
        ordering of this screen is part of meeting it.
      */}
      <Link
        href="/portal/maintenance/emergency"
        className="focus-visible:ring-ring flex min-h-14 items-center justify-center rounded-md border-2 border-red-600 bg-red-50 px-6 py-3 text-base font-semibold text-red-950 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:bg-red-950 dark:text-red-50"
      >
        Emergency — gas, flooding, no heat, break-in
      </Link>

      <Link
        href="/portal/maintenance/new"
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Report a problem
      </Link>

      {tickets.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">What you&rsquo;ve sent</h2>
          <ul className="flex flex-col gap-2">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={`/portal/maintenance/${ticket.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {emergencyDefinition(ticket.category)?.label ??
                      CATEGORY_LABELS[
                        ticket.category as keyof typeof CATEGORY_LABELS
                      ] ??
                      // R-021: a ticket opened from a text has no category -
                      // it was never asked one. "UNCATEGORIZED" is staff
                      // vocabulary and must not reach a tenant (D-10).
                      'What you texted us'}
                  </span>
                  <span className="text-muted-foreground">
                    {STATUS_WORDS[ticket.status] ?? ticket.status} ·{' '}
                    {friendlyDate(ticket.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
