import { formatPhone } from '@rental/core/comms'
import { scopeIsEmpty } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { FileUnroutedForm } from '@/components/comms/file-unrouted-form.tsx'
import { currentScope as writeScope, requireScope } from '@/lib/auth/guard.ts'
import { fileUnroutedMessage } from '@/lib/comms/actions.ts'
import { listUnroutedMessages } from '@/lib/comms/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Unsorted messages — Rental Operations' }

// Inbound messages the engine refused to file (COMM-01, R-017).
//
// Two things reach this page, and the distinction is worth showing rather
// than flattening into "couldn't deliver": a number that matched NOBODY is
// probably a wrong number or a tenant whose phone was never recorded, while
// one that matched SEVERAL people is a couple sharing a handset. The first
// needs a phone number added; the second needs a person to say which of them
// wrote it. Same queue, different fix.

const REASON_LABELS: Record<string, string> = {
  UNKNOWN_SENDER: 'No tenant or vendor has this number on file',
  AMBIGUOUS: 'More than one person has this number on file',
}

export default async function UnroutedMessagesPage() {
  const { actor } = await requireScope('message.read')
  const scope = await currentScope(actor)

  const [unrouted, sendScope] = await Promise.all([
    listUnroutedMessages(),
    writeScope('message.send'),
  ])
  const canFile = !scopeIsEmpty(sendScope)

  // Only tenants at properties this actor can see - the filing dropdown must
  // not become a directory of every tenant in the portfolio for somebody
  // scoped to one house.
  const tenants = canFile
    ? await prisma.tenant.findMany({
        where: {
          active: true,
          leaseTenants: {
            some: { lease: { propertyId: { in: scope.propertyIds } } },
          },
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      })
    : []

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← All messages
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Unsorted messages
        </h1>
        <p className="text-muted-foreground text-sm">
          These arrived from a number the system could not place. Nothing is
          filed on a guess — putting a message in the wrong person&rsquo;s
          history is worse than leaving it here.
        </p>
      </header>

      {unrouted.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing waiting. Every message that arrived found its conversation.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {unrouted.map((message) => (
            <li key={message.id} className="flex flex-col gap-3 px-4 py-3">
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {formatPhone(message.fromAddress)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {message.receivedAt
                      .toISOString()
                      .slice(0, 16)
                      .replace('T', ' ')}{' '}
                    UTC
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {REASON_LABELS[message.reason] ?? message.reason}
                </p>
                <p className="whitespace-pre-wrap">{message.body}</p>
                {/* R-097d. An unrouted message has no property, and a
                    Document must have one - so an attachment here cannot be
                    stored, and inventing a property to hang it on is exactly
                    the guess `decideRoute` refuses. What must not happen is
                    that the discarding is invisible: whoever files this needs
                    to know to ask for the photograph again. */}
                {message.attachmentsDropped > 0 && (
                  <p className="text-sm font-medium">
                    {message.attachmentsDropped}{' '}
                    {message.attachmentsDropped === 1 ? 'attachment was' : 'attachments were'} sent
                    with this and could not be kept — there was no tenancy to file them against.
                    Ask the sender to send them again once this is filed.
                  </p>
                )}
              </div>
              {canFile && tenants.length > 0 && (
                <FileUnroutedForm
                  action={fileUnroutedMessage.bind(null, message.id)}
                  rowId={message.id}
                  tenants={tenants.map((tenant) => ({
                    id: tenant.id,
                    label: `${tenant.firstName} ${tenant.lastName}`,
                  }))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
