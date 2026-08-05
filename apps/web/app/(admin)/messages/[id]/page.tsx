import { formatPhone } from '@rental/core/comms'
import { utcToWallClock } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { LogCallForm } from '@/components/comms/log-call-form.tsx'
import { ReplyForm } from '@/components/comms/reply-form.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { logCallInThread, replyInThread } from '@/lib/comms/actions.ts'
import { getThread } from '@/lib/comms/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Conversation — Rental Operations' }

// One thread's full transcript (COMM-01: "Given any staff member opens a
// thread, when reading, then full history shows including which staff member
// sent what").
//
// Staff attribution is on every outbound row, and it is not decoration: the
// question a dispute asks is who told the tenant what, and "the system" is
// not an answer anybody can act on.

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'Text',
  EMAIL: 'Email',
  PORTAL: 'Portal',
  CALL_LOG: 'Phone call',
}

const DELIVERY_LABELS: Record<string, string> = {
  QUEUED: 'Sending',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  SUPPRESSED: 'Not sent',
}

/// Times are shown in the PROPERTY's timezone, not UTC and not the viewer's
/// (D-3: "UTC in the DB, property-local timezone for display"). A transcript
/// is read against what happened at the house - a tenant saying "I called at
/// nine" means nine there.
function localStamp(instant: Date, timeZone: string): string {
  return utcToWallClock(instant, timeZone).replace('T', ' ')
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('message.read')
  const scope = await currentScope(actor)

  const thread = await getThread(id, scope)
  // A thread outside the actor's scope is indistinguishable from one that
  // does not exist - see getThread's own comment.
  if (!thread) notFound()

  const canSend = await actorCan('message.send', propertyResource(thread.property))

  const party = thread.tenant ?? thread.vendor
  const name = thread.tenant
    ? `${thread.tenant.firstName} ${thread.tenant.lastName}`
    : (thread.vendor?.name ?? thread.property.name)

  const channels = [
    'PORTAL',
    ...(party?.email ? ['EMAIL'] : []),
    ...(party?.phone ? ['SMS'] : []),
  ]

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← All messages
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="text-muted-foreground text-sm">
          {thread.property.name}
          {party?.phone ? ` · ${formatPhone(party.phone)}` : ''}
          {party?.email ? ` · ${party.email}` : ''}
        </p>
      </header>

      {thread.messages.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing in this conversation yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {thread.messages.map((message) => {
            const outbound = message.direction === 'OUTBOUND'
            const status = message.delivery?.status
            return (
              <li
                key={message.id}
                className={`flex flex-col gap-1 rounded-md border p-3 text-sm ${
                  outbound ? 'bg-muted/40' : ''
                }`}
              >
                <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>
                    {message.channel === 'CALL_LOG'
                      ? `${CHANNEL_LABELS.CALL_LOG} — logged by ${message.staffUser?.name ?? 'staff'}`
                      : outbound
                        ? `${CHANNEL_LABELS[message.channel] ?? message.channel} from ${message.staffUser?.name ?? 'staff'}`
                        : `${CHANNEL_LABELS[message.channel] ?? message.channel} from ${name}`}
                  </span>
                  <span>
                    {localStamp(message.sentAt, thread.property.timezone)}
                    {status && outbound
                      ? ` · ${DELIVERY_LABELS[status] ?? status}`
                      : ''}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{message.body}</p>
              </li>
            )
          })}
        </ol>
      )}

      {canSend && (
        <>
          <ReplyForm
            action={replyInThread.bind(null, thread.id)}
            channels={channels}
          />
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Log a phone call
            </summary>
            <div className="pt-3">
              <LogCallForm
                action={logCallInThread.bind(null, thread.id)}
                defaultOccurredAt={utcToWallClock(
                  new Date(),
                  thread.property.timezone,
                )}
              />
            </div>
          </details>
        </>
      )}
    </div>
  )
}
