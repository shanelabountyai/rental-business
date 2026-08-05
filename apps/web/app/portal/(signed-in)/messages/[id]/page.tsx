import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PortalReplyForm } from '@/components/portal/portal-reply-form.tsx'
import { replyFromPortal } from '@/lib/portal/actions.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { getTenantThread } from '@/lib/portal/queries.ts'

export const metadata = { title: 'Messages' }

// One conversation, tenant side (COMM-01).
//
// Every message, whatever channel it arrived on, in one list - which is the
// whole promise of COMM-01. A text and a portal message sit together because
// from the tenant's side they are the same conversation.

const CHANNEL_WORDS: Record<string, string> = {
  SMS: 'Text',
  EMAIL: 'Email',
  PORTAL: 'Message',
  CALL_LOG: 'Phone call',
}

/// Date and time somebody would say out loud, in the property's timezone
/// (D-3). Never UTC on a tenant-facing screen - "14:30 UTC" is not a time
/// anybody recognises as when their landlord rang.
function friendlyStamp(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(value)
}

export default async function PortalThreadPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { scope } = await requireTenantWithScope()

  const thread = await getTenantThread(id, scope)
  // A thread belonging to somebody else is a 404, not a 403 - see the query.
  if (!thread) notFound()

  const timeZone = thread.property.timezone

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/portal/messages"
          className="focus-visible:ring-ring w-fit rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← All messages
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {thread.property.name}
        </h1>
      </div>

      {thread.messages.length === 0 ? (
        <p>No messages yet. Write one below and we will get back to you.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {thread.messages.map((message) => {
            const fromThem = message.direction === 'OUTBOUND'
            return (
              <li
                key={message.id}
                className={`flex flex-col gap-1 rounded-md border p-4 ${
                  fromThem ? '' : 'bg-muted/40'
                }`}
              >
                <p className="text-muted-foreground">
                  {/*
                    Who sent it, said in words rather than shown by which side
                    of the screen the bubble sits on - §6.4 rules out encoding
                    status by position or colour alone.
                  */}
                  {fromThem ? 'From your landlord' : 'From you'} ·{' '}
                  {CHANNEL_WORDS[message.channel] ?? message.channel} ·{' '}
                  {friendlyStamp(message.sentAt, timeZone)}
                </p>
                <p className="whitespace-pre-wrap">{message.body}</p>
              </li>
            )
          })}
        </ol>
      )}

      <PortalReplyForm action={replyFromPortal.bind(null, thread.id)} />
    </div>
  )
}
