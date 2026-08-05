import { CATEGORY_LABELS } from '@rental/core/maintenance'
import Link from 'next/link'
import { requirePermission } from '@/lib/auth/guard.ts'
import { listOpenTickets } from '@/lib/maintenance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Maintenance — Rental Operations' }

const SOURCE_LABELS: Record<string, string> = {
  PORTAL: 'Portal',
  SMS: 'Text',
  EMAIL: 'Email',
  PHONE_LOGGED: 'Phone',
  STAFF: 'Staff',
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category
}

function friendlyDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(value)
}

/**
 * A bare, unsorted-by-priority list of everything open, across every source
 * (MAINT-01, MAINT-02). Guards itself rather than relying on the layout, the
 * same as every other admin section (ROLE-01).
 *
 * This is not R-023's triage queue - no priority override, no merge, no SLA
 * timer, no habitability auto-elevation. It exists so a ticket, however it
 * arrived, is visible and reachable by id before that item builds the real
 * workflow on top; R-023 owns turning this list into that queue.
 */
export default async function MaintenancePage() {
  const actor = await requirePermission('ticket.read')
  const scope = await currentScope(actor)
  const tickets = await listOpenTickets(scope)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <Link
          href="/maintenance/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Log a phone-reported request
        </Link>
      </div>
      <p className="text-muted-foreground text-sm">
        {tickets.length} open request{tickets.length === 1 ? '' : 's'} across{' '}
        {scope.propertyIds.length} propert{scope.propertyIds.length === 1 ? 'y' : 'ies'}.
      </p>

      {tickets.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing open right now.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/maintenance/${ticket.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {categoryLabel(ticket.category)}
                  {ticket.habitabilityFlag && (
                    <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
                      Habitability
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-sm">
                  {ticket.property.name} — {ticket.unit.name} ·{' '}
                  {ticket.tenant
                    ? `${ticket.tenant.firstName} ${ticket.tenant.lastName}`
                    : 'No tenant on file'}{' '}
                  · {SOURCE_LABELS[ticket.source] ?? ticket.source} ·{' '}
                  {friendlyDate(ticket.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
