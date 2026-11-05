import { friendlyTimestamp } from '@rental/core/scheduling'
import { PageHeader } from '@/components/page-header.tsx'
import { ConnectQuickBooksForm, DisconnectQuickBooksForm } from '@/components/billing/quickbooks-forms.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { connectQuickBooks, disconnectQuickBooksAction } from '@/lib/integrations/quickbooks-actions.ts'
import { quickBooksRows } from '@/lib/integrations/quickbooks.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

export const metadata = { title: 'QuickBooks' }

// R-280 (PRD 09 Q1, D-394): one QuickBooks Online company file per legal
// entity. Owner-only (`billing.connect`), as the Stripe account is. The
// callback lands back here with a bare outcome; any reason is read from the
// connection row, never from the URL.

const STATUS_WORDS: Record<string, string> = {
  CONNECTING: 'Not connected',
  CONNECTED: 'Connected',
  RECONNECT_NEEDED: 'Reconnect needed',
  DISCONNECTED: 'Disconnected',
}

const OUTCOMES: Record<string, { tone: 'ok' | 'bad'; text: string }> = {
  connected: { tone: 'ok', text: 'QuickBooks is connected.' },
  disconnected: { tone: 'ok', text: 'Disconnected from QuickBooks.' },
  failed: { tone: 'bad', text: 'QuickBooks was not connected. The reason is shown against the entity below.' },
  invalid: { tone: 'bad', text: 'That QuickBooks sign-in could not be matched to a connection here. Start again.' },
}

export default async function QuickBooksPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const actor = await requirePermission('billing.connect')
  const [rows, { result }, zone] = await Promise.all([quickBooksRows(actor.orgId), searchParams, orgTimezone(actor.orgId)])
  const outcome = result ? OUTCOMES[result] : undefined
  const connectable = rows
    .filter((row) => row.connection?.status !== 'CONNECTED')
    .map((row) => ({ id: row.legalEntityId, name: row.entityName, firstConnect: !row.connection }))

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="QuickBooks">
        <p className="text-sm text-muted-foreground">
          Each entity&apos;s books go to its own QuickBooks Online company file. Intuit runs the sign-in; this product
          never sees your QuickBooks password.
        </p>
      </PageHeader>

      <div role="status">
        {outcome && (
          <p
            className={
              outcome.tone === 'ok'
                ? 'rounded-md border border-success/35 bg-success/6 px-3 py-2 text-sm text-success'
                : 'rounded-md border border-danger/35 bg-danger/6 px-3 py-2 text-sm text-danger'
            }
          >
            {outcome.text}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm">Add a legal entity first. QuickBooks connects one company file per entity.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.legalEntityId} className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <h2 className="text-lg font-semibold break-words">{row.entityName}</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-words text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="min-w-0">{row.connection ? STATUS_WORDS[row.connection.status] ?? row.connection.status : 'Not connected'}</dd>
                {row.connection?.realmId && (
                  <>
                    <dt className="text-muted-foreground">Company id</dt>
                    <dd className="min-w-0 font-mono">{row.connection.realmId}</dd>
                  </>
                )}
                {row.connection && (
                  <>
                    <dt className="text-muted-foreground">Basis</dt>
                    <dd className="min-w-0">{row.connection.basis === 'CASH' ? 'Cash' : 'Accrual'}</dd>
                    <dt className="text-muted-foreground">Property as</dt>
                    <dd className="min-w-0">{row.connection.propertyField === 'CLASS' ? 'Class' : 'Location'}</dd>
                  </>
                )}
                {row.connection?.connectedAt && row.connection.status === 'CONNECTED' && (
                  <>
                    <dt className="text-muted-foreground">Connected</dt>
                    <dd className="min-w-0">{friendlyTimestamp(row.connection.connectedAt, zone)}</dd>
                  </>
                )}
                {row.connection?.status === 'CONNECTED' && (
                  <>
                    <dt className="text-muted-foreground">Last sync</dt>
                    <dd className="min-w-0">
                      {row.connection.lastSyncedAt ? friendlyTimestamp(row.connection.lastSyncedAt, zone) : 'Not yet'}
                    </dd>
                  </>
                )}
                {row.connection?.syncProblem && (
                  <>
                    <dt className="text-muted-foreground">Sync problem</dt>
                    <dd className="min-w-0 break-words">{row.connection.syncProblem}</dd>
                  </>
                )}
                {row.connection?.statusReason && (
                  <>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd className="min-w-0">{row.connection.statusReason}</dd>
                  </>
                )}
              </dl>
              {row.connection && ['CONNECTED', 'RECONNECT_NEEDED'].includes(row.connection.status) && (
                <DisconnectQuickBooksForm action={disconnectQuickBooksAction.bind(null, row.legalEntityId)} entityName={row.entityName} />
              )}
            </li>
          ))}
        </ul>
      )}

      {connectable.length > 0 && (
        <section aria-labelledby="qb-connect" className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 id="qb-connect" className="text-lg font-semibold">
            Connect an entity
          </h2>
          <ConnectQuickBooksForm action={connectQuickBooks} entities={connectable} />
        </section>
      )}
    </div>
  )
}
