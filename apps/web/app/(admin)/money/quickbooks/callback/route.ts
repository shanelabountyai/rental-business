import { requirePermission } from '@/lib/auth/guard.ts'
import { authUrl } from '@/lib/auth/org-url.ts'
import { audit } from '@/lib/audit/index.ts'
import { completeQuickBooksConnect } from '@/lib/integrations/quickbooks.ts'

// R-280 (PRD 09 Q1): where Intuit sends the browser after consent. Session-
// guarded, and the state must be one this org opened (quickbooks.ts), so a
// callback forged for another org's connection finds nothing. The redirect
// carries no text: the page reads the outcome from the row.

const CALLBACK = '/money/quickbooks/callback'

export async function GET(request: Request) {
  const actor = await requirePermission('billing.connect')
  const query = new URL(request.url).searchParams
  const result = await completeQuickBooksConnect(
    actor.orgId,
    { state: query.get('state'), code: query.get('code'), realmId: query.get('realmId'), error: query.get('error') },
    await authUrl(actor.orgId, CALLBACK),
  )
  if (result.ok) {
    await audit({
      action: 'integration.connected',
      entityType: 'QuickBooksConnection',
      entityId: result.id,
      orgId: actor.orgId,
      before: result.before,
      after: { status: 'CONNECTED', realmId: query.get('realmId') },
    })
  }
  const outcome = result.ok ? 'connected' : result.legalEntityId ? 'failed' : 'invalid'
  return Response.redirect(await authUrl(actor.orgId, `/money/quickbooks?result=${outcome}`), 303)
}
