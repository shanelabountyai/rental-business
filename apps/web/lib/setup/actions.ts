'use server'

import { normalizePhone } from '@rental/core/comms'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { authUrl } from '@/lib/auth/org-url.ts'
import { billingIsLive, getBillingProvider } from '@/lib/billing/provider.ts'
import { SimulatedBillingProvider } from '@/lib/billing/simulated-adapter.ts'
import { refreshOrgHealth } from '@/lib/cron/org-health.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { orgOwners } from '@/lib/platform/orgs.ts'
import { SETUP_MARKS, type SetupMark } from '@/lib/setup/checklist.ts'
import { SETUP_TEST_CENTS } from '@/lib/setup/test-payment.ts'

// The owner's three statements on /settings/setup (PRD 10 §5, R-291a): "just
// me", templates reviewed, the shared email domain. Owner-only (`staff.manage`,
// portfolio-wide). Returns rather than redirects, like every org-host action
// since D-379.

export interface SetupFormState {
  error?: string
  notice?: string
  /// Stripe's hosted invoice page, for the browser to open (D-379).
  openUrl?: string
}

const NOTICE: Record<SetupMark, [string, string]> = {
  just_me: ['Marked: you run this organisation alone.', 'Unmarked: invite a member to finish this step.'],
  templates_reviewed: ['Marked: message templates reviewed.', 'Unmarked: message templates not reviewed.'],
  shared_email: [
    'Marked: email goes from the shared domain under your organisation’s name.',
    'Unmarked: email waits for your own domain.',
  ],
}

export async function markSetupStep(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const actor = await requirePermission('staff.manage')
  const mark = String(formData.get('mark') ?? '') as SetupMark
  if (!SETUP_MARKS.includes(mark)) return { error: 'That step is not recognised.' }
  const on = formData.get('intent') === 'on'

  const changed = await prisma.$transaction(async (tx) => {
    const { setupMarks } = await tx.organization.findUniqueOrThrow({
      where: { id: actor.orgId },
      select: { setupMarks: true },
    })
    if (setupMarks.includes(mark) === on) return false
    const after = on ? [...setupMarks, mark] : setupMarks.filter((m) => m !== mark)
    // Conditional on the marks as read, so two presses audit one change.
    const { count } = await tx.organization.updateMany({
      where: { id: actor.orgId, setupMarks: { equals: setupMarks } },
      data: { setupMarks: after },
    })
    if (count === 0) return false
    await audit(
      { action: 'org.setup_marked', entityType: 'Organization', entityId: actor.orgId, orgId: actor.orgId, after: { mark, on } },
      tx,
    )
    return true
  })
  if (!changed) return { notice: 'Nothing changed: that step was already marked that way.' }
  await refreshOrgHealth(actor.orgId)
  revalidatePath('/settings/setup')
  return { notice: NOTICE[mark][on ? 0 : 1] }
}

/**
 * "Send a test text" (R-291b, PRD 10 §5 step 9): to the pressing owner's own
 * phone, through `notify()` like every send. The number they type becomes
 * their `StaffUser.phone`, because nothing else sets it and D-375's gate lets
 * an owner's own number through before the 10DLC campaign is approved. Step 9
 * counts it once the carrier reports it delivered, not when it is sent.
 */
export async function sendTestText(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const actor = await requirePermission('staff.manage')
  const owners = await orgOwners(actor.orgId)
  if (!owners.some((o) => o.id === actor.id)) return { error: 'Only an owner can receive the test text.' }
  const phone = normalizePhone(String(formData.get('phone') ?? ''))
  if (!phone) return { error: 'Enter your mobile number, with its area code.' }

  const now = new Date()
  const [me, org] = await Promise.all([
    prisma.staffUser.update({ where: { id: actor.id }, data: { phone }, select: { email: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { name: true } }),
  ])
  const outcomes = await notify({
    category: 'setup_test',
    templateKey: 'setup.test_text',
    recipient: { type: 'STAFF', id: actor.id, email: me.email, phone },
    context: { orgName: org.name },
    orgId: actor.orgId,
    // One per minute: a double press sends once, a later retry sends again.
    idempotencyKey: `setup-test-text:${actor.id}:${now.toISOString().slice(0, 16)}`,
    now,
  })
  const deliveryIds = outcomes.flatMap((o) => (o.deliveryId ? [o.deliveryId] : []))
  if (deliveryIds.length > 0) await dispatchPendingNotifications(now, 10, { deliveryIds })
  const delivery = deliveryIds.length
    ? await prisma.notificationDelivery.findUnique({
        where: { id: deliveryIds[0] },
        select: { status: true, suppressedReason: true, failureCode: true },
      })
    : null
  await audit({
    action: 'org.test_text_sent',
    entityType: 'Organization',
    entityId: actor.orgId,
    orgId: actor.orgId,
    after: { channelStatus: delivery?.status ?? 'duplicate' },
  })
  revalidatePath('/settings/setup')
  if (!delivery) return { notice: 'That test text was already sent this minute.' }
  if (delivery.status === 'SENT') {
    return { notice: `Test text sent to ${phone}. This step completes once the carrier reports it delivered.` }
  }
  const why = delivery.suppressedReason ?? delivery.failureCode
  return { error: `The test text was not sent (${delivery.status.toLowerCase()}${why ? `: ${why.replaceAll('_', ' ')}` : ''}).` }
}

/**
 * "Bill $1" (R-291b, PRD 10 §5 step 9): one invoice to the pressing owner on
 * the org's connected account, paid on Stripe's hosted page. The provider's
 * collecting gate refuses it until the account is ENABLED (D-379), and the
 * paid event is what step 9 reads, never this press (D-11, D-384).
 */
export async function billTestDollar(_previous: SetupFormState, _formData: FormData): Promise<SetupFormState> {
  const actor = await requirePermission('billing.connect')
  const me = await prisma.staffUser.findUniqueOrThrow({ where: { id: actor.id }, select: { name: true, email: true } })
  let invoice: { stripeInvoiceId: string; hostedInvoiceUrl: string }
  try {
    invoice = await getBillingProvider(actor.orgId).invoiceSetupTest({
      staffUserId: actor.id,
      name: me.name,
      email: me.email,
      amountCents: SETUP_TEST_CENTS,
      currency: 'usd',
      // One invoice per owner: a second press re-opens the same one.
      idempotencyKey: `setup-test:${actor.orgId}:${actor.id}`,
    })
  } catch (error) {
    if (error instanceof Error && ['CollectionRefusedError', 'NoConnectedAccountError'].includes(error.name)) {
      return { error: `Stripe cannot bill yet: ${error.message.replace(/^Collection refused: /, '')}` }
    }
    throw error
  }
  await audit({
    action: 'org.test_invoice_sent',
    entityType: 'Organization',
    entityId: actor.orgId,
    orgId: actor.orgId,
    after: { stripeInvoiceId: invoice.stripeInvoiceId, amountCents: SETUP_TEST_CENTS },
  })
  return { openUrl: new URL(invoice.hostedInvoiceUrl, await authUrl(actor.orgId, '/')).toString() }
}

/// The simulated hosted invoice page's "Pay" (D-27). Only without a Stripe
/// key, and only as the actor's own org: the event is emitted as that org.
export async function paySimulatedTestInvoice(
  stripeInvoiceId: string,
  _previous: SetupFormState,
  _formData: FormData,
): Promise<SetupFormState> {
  const actor = await requirePermission('billing.connect')
  if (billingIsLive() || !stripeInvoiceId.startsWith('in_simsetup')) return { error: 'That is not a simulated invoice.' }
  await new SimulatedBillingProvider(actor.orgId).paySetupTestInvoice(stripeInvoiceId, SETUP_TEST_CENTS)
  return { openUrl: await authUrl(actor.orgId, '/settings/setup') }
}
