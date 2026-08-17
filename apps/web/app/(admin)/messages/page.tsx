import Link from 'next/link'
import { propertyScope, scopeIsEmpty } from '@rental/core/rbac'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { listThreads, unroutedCount } from '@/lib/comms/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Messages — Rental Operations' }

// COMM-01's one inbox: every conversation, whatever channel it arrived on.
//
// requireScope, not a bare requirePermission('message.read') - a
// property-scoped manager holds message.read only over their own property,
// and a resource-less check would deny them an inbox that should show them
// their own real conversations.

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'Text',
  EMAIL: 'Email',
  PORTAL: 'Portal',
  CALL_LOG: 'Call',
}

function participantName(thread: {
  tenant: { firstName: string; lastName: string } | null
  vendor: { name: string } | null
  property: { name: string }
}): string {
  if (thread.tenant) return `${thread.tenant.firstName} ${thread.tenant.lastName}`
  if (thread.vendor) return thread.vendor.name
  return thread.property.name
}

export default async function MessagesPage() {
  const { actor } = await requireScope('message.read')
  const scope = await currentScope(actor)
  const [threads, unrouted, canWriteTemplates] = await Promise.all([
    listThreads(scope),
    unroutedCount(),
    // Portfolio-wide and resource-less, like the templates page itself: a
    // template belongs to no property (R-049).
    actorCan('template.write'),
  ])
  // SCOPED, not `actorCan('message.send')` with no resource — a
  // property-scoped manager holds message.send over their own properties
  // only, and a resource-less check would hide the link from exactly the
  // person whose job this is (the same trap the rent roll's `canSend`
  // documents).
  const canSendAnnouncements = !scopeIsEmpty(propertyScope(actor, 'message.send'))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
        <p className="text-muted-foreground text-sm">
          Every conversation, whatever channel it came in on. Logged calls sit
          in the same history.
        </p>
        <div className="flex gap-4">
          {canWriteTemplates && (
            <Link
              href="/messages/templates"
              className="focus-visible:ring-ring w-fit text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
            >
              Message templates
            </Link>
          )}
          {canSendAnnouncements && (
            <Link
              href="/messages/announcements"
              className="focus-visible:ring-ring w-fit text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
            >
              Send an announcement
            </Link>
          )}
        </div>
      </header>

      {unrouted > 0 && (
        <Link
          href="/messages/unrouted"
          className="focus-visible:ring-ring flex min-h-11 items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            {unrouted} message{unrouted === 1 ? '' : 's'} arrived from a number
            we could not place.
          </span>
          <span className="font-medium underline underline-offset-2">
            Sort them out
          </span>
        </Link>
      )}

      {threads.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No conversations yet for the properties you can see.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {threads.map((thread) => {
            const latest = thread.messages[0]
            return (
              <li key={thread.id}>
                <Link
                  href={`/messages/${thread.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex flex-col gap-1 px-4 py-3 text-sm focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {participantName(thread)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {thread.property.name}
                      {latest &&
                        ` · ${CHANNEL_LABELS[latest.channel] ?? latest.channel} · ${latest.sentAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`}
                    </span>
                  </div>
                  {latest ? (
                    <p className="text-muted-foreground line-clamp-1">
                      {latest.direction === 'OUTBOUND' ? 'You: ' : ''}
                      {latest.body}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No messages yet.</p>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
