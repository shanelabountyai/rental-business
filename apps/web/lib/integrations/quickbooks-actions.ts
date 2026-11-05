'use server'

import type { FormState } from '@/components/auth-form.tsx'
import type { StripeFormState } from '@/lib/integrations/stripe-actions.ts'
import type { BusinessDate } from '@rental/core/scheduling'
import { businessDate, businessDateToUtc, friendlyBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { authUrl } from '@/lib/auth/org-url.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { audit } from '@/lib/audit/index.ts'
import { orgTimezone } from '@/lib/support/grants.ts'
import { replayQuickBooksDate, syncQuickBooks } from './quickbooks-sync.ts'
import { answerSimulatedConsent, disconnectQuickBooks, orgIdForQuickBooksState, startQuickBooksConnect } from './quickbooks.ts'

// R-280 (PRD 09 Q1): the owner connects or disconnects an entity's
// QuickBooks file. The org is the session's, never a form field; the entity
// must be one of its own. Like Stripe's, these hand the browser a URL to open
// rather than calling `redirect()` (D-379).

const CALLBACK = '/money/quickbooks/callback'

export async function connectQuickBooks(_previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const actor = await requirePermission('billing.connect')
  const basis = formData.get('basis')
  const propertyField = formData.get('propertyField')
  const started = await startQuickBooksConnect(
    actor.orgId,
    {
      legalEntityId: String(formData.get('legalEntityId') ?? ''),
      basis: basis === 'CASH' || basis === 'ACCRUAL' ? basis : undefined,
      propertyField: propertyField === 'LOCATION' ? 'LOCATION' : 'CLASS',
    },
    await authUrl(actor.orgId, CALLBACK),
  )
  return started.ok ? { openUrl: started.url } : { error: started.error }
}

export async function disconnectQuickBooksAction(
  legalEntityId: string,
  _previous: StripeFormState,
  _formData: FormData,
): Promise<StripeFormState> {
  const actor = await requirePermission('billing.connect')
  const done = await disconnectQuickBooks(actor.orgId, legalEntityId)
  if (!done.ok) return { error: done.error }
  await audit({
    action: 'integration.disconnected',
    entityType: 'QuickBooksConnection',
    entityId: done.id,
    orgId: actor.orgId,
    before: done.before,
    after: { status: 'DISCONNECTED' },
  })
  // A full load, as after a connect: the row this form sits in changes shape.
  return { openUrl: await authUrl(actor.orgId, '/money/quickbooks?result=disconnected') }
}

/// The simulated consent page's submit (D-27). The state must be the actor's
/// own org's: a guessed state is somebody else's connection.
export async function answerSimulatedQuickBooks(state: string, _previous: StripeFormState, formData: FormData): Promise<StripeFormState> {
  const actor = await requirePermission('billing.connect')
  if ((await orgIdForQuickBooksState(state)) !== actor.orgId) return { error: 'That QuickBooks sign-in is not yours.' }
  const realmId = String(formData.get('realmId') ?? '').trim()
  const approve = formData.get('answer') === 'approve'
  if (approve && !/^[A-Za-z0-9_-]{1,64}$/.test(realmId)) return { error: 'Enter a company id: letters, digits, - or _.' }
  return { openUrl: await answerSimulatedConsent(state, { approve, realmId }, await authUrl(actor.orgId, CALLBACK)) }
}

// R-283 (PRD 09 Q10): the reconciliation page's two buttons. Owner-only like
// the connection itself, and audited whatever the outcome, refusals
// included: the trail is who pushed what into the books, and when.

const RECONCILE = '/money/quickbooks/reconciliation'

export async function syncQuickBooksNowAction(legalEntityId: string, _previous: FormState, _formData: FormData): Promise<FormState> {
  const actor = await requirePermission('billing.connect')
  const [result] = await syncQuickBooks(actor.orgId, { legalEntityId })
  if (!result) return { error: 'That entity is not connected to QuickBooks.' }
  await audit({
    action: 'integration.sync_requested',
    entityType: 'QuickBooksConnection',
    entityId: result.connectionId,
    orgId: actor.orgId,
    after: result,
  })
  revalidatePath(RECONCILE)
  if (result.outcome !== 'synced') return { error: result.reason }
  return {
    notice: `Synced: ${result.posted} journal ${result.posted === 1 ? 'entry' : 'entries'} posted, ${result.excluded} excluded.${
      result.backfilledDays > 0 ? ` ${result.backfilledDays} ${result.backfilledDays === 1 ? 'day' : 'days'} of history pushed.` : ''
    }`,
  }
}

export async function replayQuickBooksDateAction(legalEntityId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const actor = await requirePermission('billing.connect')
  const day = String(formData.get('day') ?? '')
  // A hand-made POST can send anything; friendlyBusinessDate throws on it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return { error: 'Choose a date to replay.' }
  const result = await replayQuickBooksDate(actor.orgId, legalEntityId, day as BusinessDate)
  if (result.connectionId) {
    await audit({
      action: 'integration.replayed',
      entityType: 'QuickBooksConnection',
      entityId: result.connectionId,
      orgId: actor.orgId,
      after: { day, ...result },
    })
  }
  revalidatePath(RECONCILE)
  if (!result.ok) return { error: result.error }
  return {
    notice: `Replayed ${friendlyBusinessDate(day as BusinessDate)}: ${result.journals} journal ${result.journals === 1 ? 'entry' : 'entries'} checked, ${result.reposted} posted again.`,
  }
}

// R-284 (PRD 09 Q11, D-400): the owner picks the day to push history from,
// once per connection, and the first batch runs at once. Every later sync
// carries it on until history is done.

export async function startQuickBooksBackfillAction(legalEntityId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const actor = await requirePermission('billing.connect')
  const from = String(formData.get('from') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) return { error: 'Choose the day to push history from.' }
  if (from >= businessDate(new Date(), await orgTimezone(actor.orgId))) return { error: 'Choose a day before today.' }
  const connection = await prisma.quickBooksConnection.findFirst({
    where: { orgId: actor.orgId, legalEntityId, status: 'CONNECTED' },
    select: { id: true, backfillFrom: true },
  })
  if (!connection) return { error: 'That entity is not connected to QuickBooks.' }
  // Once: a second press cannot move a backfill that is already running.
  const { count } = await prisma.quickBooksConnection.updateMany({
    where: { id: connection.id, backfillFrom: null },
    data: { backfillFrom: businessDateToUtc(from as BusinessDate) },
  })
  if (count === 0) return { error: 'History is already being pushed for this entity.' }
  const [result] = await syncQuickBooks(actor.orgId, { legalEntityId })
  await audit({
    action: 'integration.backfill_started',
    entityType: 'QuickBooksConnection',
    entityId: connection.id,
    orgId: actor.orgId,
    after: { backfillFrom: from, firstRun: result ?? null },
  })
  revalidatePath('/money/quickbooks')
  const start = `Pushing history from ${friendlyBusinessDate(from as BusinessDate)}.`
  if (!result || result.outcome !== 'synced') return { error: `${start} The first batch did not run: ${result?.reason ?? 'not connected'}` }
  return { notice: `${start} ${result.backfilledDays} ${result.backfilledDays === 1 ? 'day' : 'days'} pushed so far; each sync carries on.` }
}
