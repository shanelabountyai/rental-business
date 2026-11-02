import 'server-only'

import { randomBytes } from 'node:crypto'
import type { ConnectStatus, PlatformFeeFact } from '@rental/core/billing'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { orgIdForStripeAccount, orgIntegration, saveOrgIntegration } from './store.ts'

// Per-org Stripe Connect onboarding and the platform fee (R-277b, PRD 10
// §2.2 and §2.4, D-316, D-379).
//
// `OrgIntegration(STRIPE).status` is NOT_STARTED → ONBOARDING (account
// created) → RESTRICTED (details submitted, Stripe will not charge yet) →
// ENABLED (`charges_enabled`), and DISABLED once the org deauthorises us.
// Only `account.updated` moves it past ONBOARDING; this module never decides
// an account is chargeable on its own say-so.
//
// SIMULATED (D-7), on the pattern of twilio-provisioning.ts. `StripeConnector`
// is the seam a real driver replaces (`POST /v1/accounts` type standard, and
// an Account Link). The simulator keeps its OWN state in
// `SimulatedStripeAccount` (D-27): its hosted-onboarding stand-in writes
// there and emits `account.updated` built from that row, never from our
// config. A row it made carries `provisionedBy: 'simulated'`, and with a real
// key configured that row never collects (`collectionRefusal`).

export interface StripeConnector {
  readonly name: string
  /// A Standard connected account; returns its id.
  createAccount(): Promise<string>
  /// A single-use link into the provider's hosted onboarding.
  accountLink(accountId: string, urls: { refreshUrl: string; returnUrl: string }): Promise<string>
}

class SimulatedStripeConnector implements StripeConnector {
  readonly name = 'simulated'

  async createAccount() {
    const accountId = `acct_sim${randomBytes(8).toString('hex')}`
    await prisma.simulatedStripeAccount.create({
      data: { accountId, currentlyDue: ['business_type', 'external_account', 'tos_acceptance.date'] },
    })
    return accountId
  }

  /// The stand-in for Stripe's hosted onboarding, absolute on the org's own
  /// host as Stripe's link is on Stripe's. It always returns to /money/stripe,
  /// so it carries no return URL a link could forge.
  async accountLink(accountId: string, urls: { returnUrl: string }) {
    return new URL(`/money/stripe/simulated/${accountId}`, urls.returnUrl).href
  }
}

export const stripeConnector: StripeConnector = new SimulatedStripeConnector()

/**
 * What the simulated hosted page does when the owner submits it: records the
 * answer in the simulator's own row and delivers the `account.updated` Stripe
 * would send, through the same pipeline the Connect route drives. `complete`
 * false leaves a bank account due, which Stripe answers with RESTRICTED.
 */
export async function submitSimulatedOnboarding(accountId: string, complete: boolean): Promise<void> {
  const account = await prisma.simulatedStripeAccount.update({
    where: { accountId },
    data: complete
      ? { detailsSubmitted: true, chargesEnabled: true, payoutsEnabled: true, currentlyDue: [], disabledReason: null }
      : { detailsSubmitted: true, chargesEnabled: false, currentlyDue: ['external_account'], disabledReason: 'requirements.past_due' },
  })
  await emitSimulated(accountId, 'account.updated', {
    id: accountId,
    details_submitted: account.detailsSubmitted,
    charges_enabled: account.chargesEnabled,
    payouts_enabled: account.payoutsEnabled,
    requirements: { currently_due: account.currentlyDue, disabled_reason: account.disabledReason },
  })
}

/// The org pressing "disconnect" in its own Stripe dashboard.
export async function deauthorizeSimulated(accountId: string): Promise<void> {
  await prisma.simulatedStripeAccount.update({ where: { accountId }, data: { deauthorizedAt: new Date() } })
  await emitSimulated(accountId, 'account.application.deauthorized', { id: 'ca_simulated', object: 'application' })
}

async function emitSimulated(accountId: string, type: string, object: Record<string, unknown>) {
  const orgId = await orgIdForStripeAccount(accountId)
  if (!orgId) throw new Error(`No org holds account ${accountId}.`)
  const { processStripeEvent } = await import('@/lib/billing/webhook.ts')
  await processStripeEvent(orgId, {
    id: `evt_simacct${randomBytes(12).toString('hex')}`,
    type,
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: { object },
  })
}

export type StripeRow = { id: string; status: string; statusReason: string | null; accountId: string | null; provisionedBy: string | null }

export async function stripeRow(orgId: string): Promise<StripeRow | null> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider: 'STRIPE' } },
    select: { id: true, status: true, statusReason: true, config: true },
  })
  if (!row) return null
  const config = (row.config ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof config[key] === 'string' ? (config[key] as string) : null)
  return { id: row.id, status: row.status, statusReason: row.statusReason, accountId: text('accountId'), provisionedBy: text('provisionedBy') }
}

/**
 * Opens onboarding: a new link for an account still ONBOARDING or
 * RESTRICTED (links are single-use and expire), otherwise a new account,
 * claimed conditionally so two presses create one. DISABLED starts over on a
 * new account, since a Standard account that deauthorised us is the org's to
 * reconnect. Refused for org #0, which bills on the platform account itself
 * (D-362): connecting it would strand every customer already there.
 */
export async function startStripeOnboarding(
  orgId: string,
  urls: { refreshUrl: string; returnUrl: string },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (orgId === DEFAULT_ORG_ID) {
    return { ok: false, error: 'This organisation bills on the platform Stripe account and cannot connect another.' }
  }
  const row = await stripeRow(orgId)
  if (row?.status === 'ENABLED') return { ok: false, error: 'Stripe is already connected and collecting.' }
  if (row?.accountId && (row.status === 'ONBOARDING' || row.status === 'RESTRICTED')) {
    return { ok: true, url: await stripeConnector.accountLink(row.accountId, urls) }
  }

  const claimed = row
    ? (
        await prisma.orgIntegration.updateMany({
          where: { orgId, provider: 'STRIPE', status: { in: ['NOT_STARTED', 'DISABLED'] } },
          data: { status: 'ONBOARDING', statusReason: null },
        })
      ).count === 1
    : await prisma.orgIntegration
        .create({ data: { orgId, provider: 'STRIPE', status: 'ONBOARDING' } })
        .then(() => true, (error: unknown) => (isUniqueViolation(error) ? false : Promise.reject(error)))
  if (!claimed) return { ok: false, error: 'Stripe onboarding has already started for this organisation.' }

  try {
    const accountId = await stripeConnector.createAccount()
    await saveOrgIntegration(orgId, 'STRIPE', {
      status: 'ONBOARDING',
      config: { provisionedBy: stripeConnector.name, accountId, startedAt: new Date().toISOString() },
    })
    return { ok: true, url: await stripeConnector.accountLink(accountId, urls) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Stripe onboarding stopped unexpectedly.'
    await saveOrgIntegration(orgId, 'STRIPE', { status: 'NOT_STARTED', statusReason: reason })
    return { ok: false, error: reason }
  }
}

/**
 * `account.updated` → the row's status, with Stripe's reason. A DISABLED or
 * NOT_STARTED row is left alone: an event for an account we were
 * disconnected from cannot reconnect it. Stripe does not promise order, so an
 * event older than the last one applied is skipped rather than allowed to
 * move an ENABLED account back.
 */
export async function applyAccountStatus(
  orgId: string,
  update: { status: ConnectStatus; reason: string | null; at: Date },
): Promise<string> {
  const row = await prisma.orgIntegration.findUnique({
    where: { orgId_provider: { orgId, provider: 'STRIPE' } },
    select: { id: true, status: true, config: true, updatedAt: true },
  })
  if (!row || !['ONBOARDING', 'RESTRICTED', 'ENABLED'].includes(row.status)) {
    return `account status ${update.status} ignored: row is ${row?.status ?? 'missing'}`
  }
  const config = (row.config ?? {}) as Record<string, string>
  if (config.accountEventAt && new Date(config.accountEventAt) > update.at) {
    return `account status ${update.status} ignored: older than the last update`
  }
  // Conditional on the row as read, so a deauthorisation landing meanwhile wins.
  const { count } = await prisma.orgIntegration.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: {
      status: update.status,
      statusReason: update.reason,
      config: { ...config, accountEventAt: update.at.toISOString() },
    },
  })
  return count === 1 ? `account ${row.status} → ${update.status}` : 'account status raced another update'
}

/// `account.application.deauthorized`: DISABLED, collection frozen, owner told.
/// Nothing is deleted; the account id stays on the row as the record.
export async function applyDeauthorized(orgId: string): Promise<string> {
  const row = await stripeRow(orgId)
  if (!row || row.status === 'DISABLED') return `deauthorisation ignored: row is ${row?.status ?? 'missing'}`
  const reason = 'The organisation disconnected this platform from its Stripe dashboard.'
  await saveOrgIntegration(orgId, 'STRIPE', { status: 'DISABLED', statusReason: reason })
  await raiseOwnerTask(orgId, reason)
  return `account ${row.status} → DISABLED`
}

export async function recordPlatformFee(orgId: string, fee: PlatformFeeFact, stripeEventId: string): Promise<string> {
  try {
    await prisma.platformFee.create({ data: { orgId, ...fee, stripeEventId } })
    return `platform fee ${fee.amountCents} on ${fee.stripeChargeId ?? 'an unnamed charge'}`
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return `platform fee ${fee.stripeApplicationFeeId} already recorded`
  }
}

/**
 * Why this org may not start collecting money, or null. A STRIPE row governs
 * once it exists: anything but ENABLED refuses. With no row, org #0 bills on
 * the platform account; any other org is refused against a real key and
 * allowed on the simulator, which has no account to route to (D-378). A
 * simulated account never collects against a real key: Stripe has never
 * heard of it.
 */
export async function collectionRefusal(orgId: string): Promise<string | null> {
  const row = await orgIntegration(orgId, 'STRIPE')
  if (!row) return orgId === DEFAULT_ORG_ID || !billingIsLive() ? null : 'No Stripe account is connected.'
  if (row.status !== 'ENABLED') return `The Stripe account is ${row.status.toLowerCase().replace('_', ' ')}.`
  if (billingIsLive() && row.config.provisionedBy === 'simulated') return 'The connected Stripe account is simulated.'
  return null
}

export class CollectionRefusedError extends Error {
  constructor(reason: string) {
    super(`Collection refused: ${reason}`)
    this.name = 'CollectionRefusedError'
  }
}

/// Throws, and tells the owner, when the org may not collect (PRD 10 §2.2:
/// a Task, not a silent skip). One Task per org per day however many
/// collections were refused.
export async function assertCanCollect(orgId: string): Promise<void> {
  const reason = await collectionRefusal(orgId)
  if (!reason) return
  await raiseOwnerTask(orgId, reason)
  throw new CollectionRefusedError(reason)
}

/// Read here rather than imported from provider.ts, which imports this module.
const billingIsLive = () => Boolean(process.env.STRIPE_SECRET_KEY?.trim())

async function raiseOwnerTask(orgId: string, reason: string) {
  // ponytail: a Task needs a property, and this one is about the whole org,
  // so it lands on the org's oldest active property. An org-level queue is a
  // schema change for when a second org-wide task type exists.
  const property = await prisma.property.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, timezone: true },
  })
  if (!property) return
  await createTask(prisma, {
    propertyId: property.id,
    type: 'stripe_collection_refused',
    subjectType: 'Organization',
    subjectId: orgId,
    businessDate: businessDate(new Date(), property.timezone),
    priority: 'URGENT',
    title: `Rent collection is off: ${reason} Reconnect Stripe.`,
  })
}
