'use server'

import type { FormState } from '@/components/auth-form.tsx'
import { authUrl } from '@/lib/auth/org-url.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { audit } from '@/lib/audit/index.ts'
import { orgIdForStripeAccount } from './store.ts'
import { startStripeOnboarding, stripeRow, submitSimulatedOnboarding } from './stripe-onboarding.ts'

// R-277b (PRD 10 §2.2): the owner connects the org's own Stripe account. The
// org is the session's, never a form field, so nobody can open onboarding
// for an org they do not act in.
//
// Both return the URL for the BROWSER to open rather than calling
// `redirect()`: the Account Link is Stripe's page, a full navigation, and a
// server-action redirect on an org host lost the session in e2e (the target
// came back as /login). Unexplained, and out of scope here; recorded in D-379.

export type StripeFormState = FormState & { openUrl?: string }

export async function connectStripe(_previous: StripeFormState, _formData: FormData): Promise<StripeFormState> {
  const actor = await requirePermission('billing.connect')
  const before = await stripeRow(actor.orgId)
  const started = await startStripeOnboarding(actor.orgId, {
    refreshUrl: await authUrl(actor.orgId, '/money/stripe'),
    returnUrl: await authUrl(actor.orgId, '/money/stripe'),
  })
  if (!started.ok) return { error: started.error }
  // Audited when an account was created; a fresh link to the same one is not a change.
  const after = await stripeRow(actor.orgId)
  if (after && after.accountId !== before?.accountId) {
    await audit({
      action: 'integration.provision_started',
      entityType: 'OrgIntegration',
      entityId: after.id,
      orgId: actor.orgId,
      before: before ? { status: before.status, accountId: before.accountId } : undefined,
      after: { provider: 'STRIPE', status: after.status, accountId: after.accountId },
    })
  }
  return { openUrl: started.url }
}

/// The simulated hosted onboarding's submit (D-27). The account must be the
/// actor's own org's: a guessed account id is somebody else's bank account.
export async function submitSimulatedStripe(
  accountId: string,
  _previous: StripeFormState,
  formData: FormData,
): Promise<StripeFormState> {
  const actor = await requirePermission('billing.connect')
  if ((await orgIdForStripeAccount(accountId)) !== actor.orgId) return { error: 'That is not your Stripe account.' }
  await submitSimulatedOnboarding(accountId, formData.get('outcome') === 'complete')
  // Absolute on the org's host, as Stripe's return URL is.
  return { openUrl: await authUrl(actor.orgId, '/money/stripe') }
}
