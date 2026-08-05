import Link from 'next/link'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { listTenantThreads } from '@/lib/portal/queries.ts'

export const metadata = { title: 'Messages' }

// The tenant half of COMM-01's one threaded history. The same Thread rows the
// staff inbox reads (R-017), scoped to this tenant.

export default async function PortalMessagesPage() {
  const { scope } = await requireTenantWithScope()
  const threads = await listTenantThreads(scope)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
        <p>
          Messages between you and your landlord. Texts, emails and messages
          sent here all appear in the same place.
        </p>
      </div>

      {threads.length === 0 ? (
        <p>
          You have no messages yet. You can also call or text the number on
          your lease.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {threads.map((thread) => {
            const latest = thread.messages[0]
            return (
              <li key={thread.id}>
                <Link
                  href={`/portal/messages/${thread.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  <span className="font-medium">{thread.property.name}</span>
                  {latest ? (
                    <span className="text-muted-foreground line-clamp-2">
                      {/*
                        Whose message it was, in words. OUTBOUND is written
                        from the LANDLORD's side throughout this product, so
                        outbound reads as "them" to a tenant - getting this
                        backwards would attribute the landlord's words to the
                        tenant in their own transcript.
                      */}
                      {latest.direction === 'OUTBOUND' ? 'Them: ' : 'You: '}
                      {latest.body}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No messages yet.</span>
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
