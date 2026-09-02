import { friendlyDate } from '@rental/core/scheduling'
import { CATEGORY_LABELS, ticketGlows } from '@rental/core/maintenance'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
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

/**
 * A bare, unsorted-by-priority list of everything open, across every source
 * (MAINT-01, MAINT-02). Guards itself rather than relying on the layout, the
 * same as every other admin section (ROLE-01).
 *
 * This is not R-023's triage queue - no priority override, no merge, no SLA
 * timer, no habitability auto-elevation. It exists so a ticket, however it
 * arrived, is visible and reachable by id before that item builds the real
 * workflow on top; R-023 owns turning this list into that queue.
 *
 * `requireScope`, NOT a bare `requirePermission('ticket.read')` (R-050 found
 * this the same way R-008 found it elsewhere): a resource-less check asks
 * "may you see EVERY ticket, everywhere", which a property-scoped manager -
 * i.e. every manager in a multi-entity portfolio - cannot answer yes to, and
 * the bare check denied them this screen outright. Found because the
 * dashboard's own e2e coverage drills a scoped manager into this exact page.
 */
export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<{ glowing?: string }>
}) {
  const { actor } = await requireScope('ticket.read')
  const [scope, { glowing }] = await Promise.all([currentScope(actor), searchParams])
  const allTickets = await listOpenTickets(scope)

  // R-050's dashboard drills in with `?glowing=1` for "emergency/urgent open
  // >48h" - the same `ticketGlows` clock the tile itself counts by, so the
  // number on the tile and the rows shown here can never disagree.
  const now = new Date()
  const tickets = glowing === '1' ? allTickets.filter((t) => ticketGlows(t, now)) : allTickets

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
        {glowing === '1'
          ? `${tickets.length} of ${allTickets.length} open requests are emergency/urgent and open past 48h.`
          : `${tickets.length} open request${tickets.length === 1 ? '' : 's'} across ${scope.propertyIds.length} propert${scope.propertyIds.length === 1 ? 'y' : 'ies'}.`}
        {glowing === '1' && (
          <>
            {' '}
            <Link href="/maintenance" className="underline underline-offset-2">
              Clear filter
            </Link>
          </>
        )}
      </p>

      {tickets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {glowing === '1' ? 'Nothing glowing right now.' : 'Nothing open right now.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/maintenance/${ticket.id}`}
                className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {categoryLabel(ticket.category)}
                  {ticket.habitabilityFlag && (
                    <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
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
                  {friendlyDate(ticket.createdAt, ticket.property.timezone)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
