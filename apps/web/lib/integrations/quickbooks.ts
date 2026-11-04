import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import type { AccountingBasis, AccountingPropertyField } from '@rental/db'
import { openSecret, sealSecret } from '@rental/core/auth'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { createTask } from '@/lib/tasks/create.ts'

// QuickBooks Online connections, one per legal entity (R-280, PRD 09 Q1,
// D-394, D-396). Intuit OAuth 2.0: the owner consents on Intuit's page, the
// callback brings a code and the company's realmId, the code buys a one-hour
// access token and a refresh token. `quickBooksAccessToken` is the only way
// anything (R-281's account list, R-282's sync) gets a token: it refreshes
// before expiry, and a refresh Intuit refuses turns the connection
// RECONNECT_NEEDED and puts a task in front of the owner.
//
// SIMULATED (D-7), on the pattern of stripe-onboarding.ts. `QuickBooksAuthorizer`
// is the seam a real driver replaces (appcenter.intuit.com/connect/oauth2,
// oauth.platform.intuit.com/oauth2/v1/tokens/bearer, .../tokens/revoke). The
// simulator keeps its own grants in `SimulatedQuickBooksGrant` (D-27).

export interface QuickBooksTokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
}

/// Intuit's `invalid_grant`: the refresh token is expired, revoked or already
/// rotated. Only this moves a connection to RECONNECT_NEEDED; a timeout or a
/// 5xx is thrown as an ordinary error and the next call tries again.
export class QuickBooksGrantRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickBooksGrantRefused'
  }
}

export interface QuickBooksAuthorizer {
  readonly name: string
  /// Where the browser goes to consent. `redirectUri` is our callback.
  authorizeUrl(state: string, redirectUri: string): string
  exchangeCode(code: string, redirectUri: string): Promise<QuickBooksTokens>
  refresh(refreshToken: string): Promise<QuickBooksTokens>
  /// Revokes the grant at the provider. Best effort from our side (disconnect).
  revoke(refreshToken: string): Promise<void>
}

const ACCESS_TTL_MS = 60 * 60 * 1000

class SimulatedQuickBooksAuthorizer implements QuickBooksAuthorizer {
  readonly name = 'simulated'

  /// The stand-in for Intuit's consent page, on the org's own host.
  authorizeUrl(state: string, redirectUri: string) {
    const url = new URL('/money/quickbooks/simulated', redirectUri)
    url.searchParams.set('state', state)
    return url.href
  }

  async exchangeCode(code: string) {
    const { count } = await prisma.simulatedQuickBooksGrant.updateMany({
      where: { code, codeUsedAt: null, revokedAt: null },
      data: { codeUsedAt: new Date() },
    })
    if (count !== 1) throw new QuickBooksGrantRefused('The authorization code is invalid or already used.')
    const grant = await prisma.simulatedQuickBooksGrant.findUniqueOrThrow({ where: { code } })
    return { accessToken: grant.accessToken, refreshToken: grant.refreshToken, accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS) }
  }

  /// Rotates on every use and the old token dies at once.
  async refresh(refreshToken: string) {
    const next = { refreshToken: token('rt'), accessToken: token('at') }
    const { count } = await prisma.simulatedQuickBooksGrant.updateMany({
      where: { refreshToken, revokedAt: null },
      data: next,
    })
    if (count !== 1) throw new QuickBooksGrantRefused('The refresh token is invalid, expired or revoked.')
    return { ...next, accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS) }
  }

  async revoke(refreshToken: string) {
    await prisma.simulatedQuickBooksGrant.updateMany({ where: { refreshToken, revokedAt: null }, data: { revokedAt: new Date() } })
  }
}

export const quickBooksAuthorizer: QuickBooksAuthorizer = new SimulatedQuickBooksAuthorizer()

const token = (prefix: string) => `${prefix}_sim${randomBytes(16).toString('hex')}`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const purpose = (orgId: string, legalEntityId: string) => `quickbooks/${orgId}/${legalEntityId}`
/// How long a consent page may stay open before its state is refused.
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

function seal(orgId: string, legalEntityId: string, tokens: QuickBooksTokens): string {
  return sealSecret(
    JSON.stringify({ ...tokens, accessExpiresAt: tokens.accessExpiresAt.toISOString() }),
    purpose(orgId, legalEntityId),
  )
}

function open(orgId: string, legalEntityId: string, sealed: string | null): QuickBooksTokens | null {
  const plain = sealed ? openSecret(sealed, purpose(orgId, legalEntityId)) : null
  if (!plain) return null
  try {
    const value = JSON.parse(plain) as { accessToken: string; refreshToken: string; accessExpiresAt: string }
    return { accessToken: value.accessToken, refreshToken: value.refreshToken, accessExpiresAt: new Date(value.accessExpiresAt) }
  } catch {
    return null
  }
}

/**
 * Opens consent for one of the org's entities. A first connect creates the
 * row with the basis (D-393: required, no default) and the property field
 * (D-395); a reconnect keeps both, since books already kept on one basis do
 * not change basis by pressing a button. Returns the consent URL.
 */
export async function startQuickBooksConnect(
  orgId: string,
  input: { legalEntityId: string; basis?: AccountingBasis; propertyField?: AccountingPropertyField },
  redirectUri: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const entity = await prisma.legalEntity.findFirst({
    where: { id: input.legalEntityId, orgId, active: true },
    select: { id: true, quickBooksConnection: { select: { status: true } } },
  })
  if (!entity) return { ok: false, error: 'Choose one of your active entities.' }
  if (entity.quickBooksConnection?.status === 'CONNECTED') {
    return { ok: false, error: 'That entity is already connected to QuickBooks.' }
  }
  if (!entity.quickBooksConnection && !input.basis) {
    return { ok: false, error: 'Choose cash or accrual. It decides which month income lands in, so it has no default.' }
  }

  const state = randomBytes(32).toString('base64url')
  const pending = { oauthStateHash: sha256(state), oauthStartedAt: new Date() }
  if (entity.quickBooksConnection) {
    await prisma.quickBooksConnection.update({ where: { legalEntityId: entity.id }, data: pending })
  } else {
    const created = await prisma.quickBooksConnection
      .create({
        data: {
          orgId,
          legalEntityId: entity.id,
          basis: input.basis!,
          propertyField: input.propertyField ?? 'CLASS',
          ...pending,
        },
      })
      .then(() => true, (error: unknown) => (isUniqueViolation(error) ? false : Promise.reject(error)))
    if (!created) return { ok: false, error: 'A QuickBooks connection for that entity was just started. Reload the page.' }
  }
  return { ok: true, url: quickBooksAuthorizer.authorizeUrl(state, redirectUri) }
}

export type CompleteResult =
  | { ok: true; id: string; legalEntityId: string; before: { status: string; realmId: string | null } }
  | { ok: false; error: string; legalEntityId?: string }

/**
 * The OAuth callback. The state must be one this org opened, unexpired, and
 * it is spent on first use whatever happens next. A reconnect must come back
 * with the same company file: a different realm would post one entity's
 * history into another file.
 */
export async function completeQuickBooksConnect(
  orgId: string,
  callback: { state: string | null; code: string | null; realmId: string | null; error: string | null },
  redirectUri: string,
  now = new Date(),
): Promise<CompleteResult> {
  if (!callback.state) return { ok: false, error: 'QuickBooks did not say which connection this was. Start again.' }
  const stateHash = sha256(callback.state)
  const row = await prisma.quickBooksConnection.findFirst({ where: { oauthStateHash: stateHash, orgId } })
  if (!row) return { ok: false, error: 'That QuickBooks sign-in link is not valid here. Start again.' }
  // Spent now, conditionally, so a replayed callback finds nothing.
  const { count } = await prisma.quickBooksConnection.updateMany({
    where: { id: row.id, oauthStateHash: stateHash },
    data: { oauthStateHash: null, oauthStartedAt: null },
  })
  // The page shows the reason from the row, so the callback URL never carries
  // text onto our page. A CONNECTED row keeps its own (none).
  const fail = async (error: string): Promise<CompleteResult> => {
    await prisma.quickBooksConnection.updateMany({ where: { id: row.id, status: { not: 'CONNECTED' } }, data: { statusReason: error } })
    return { ok: false, error, legalEntityId: row.legalEntityId }
  }
  if (count !== 1) return fail('That QuickBooks sign-in link was already used. Start again.')
  if (!row.oauthStartedAt || now.getTime() - row.oauthStartedAt.getTime() > OAUTH_STATE_TTL_MS) {
    return fail('That QuickBooks sign-in took too long. Start again.')
  }
  if (callback.error || !callback.code || !callback.realmId) {
    return fail(callback.error === 'access_denied' ? 'The QuickBooks connection was cancelled.' : 'QuickBooks did not grant access.')
  }
  if (row.realmId && row.realmId !== callback.realmId) {
    return fail('That is a different QuickBooks company from the one this entity was connected to. Choose the same company.')
  }

  let tokens: QuickBooksTokens
  try {
    tokens = await quickBooksAuthorizer.exchangeCode(callback.code, redirectUri)
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'QuickBooks did not grant access.')
  }
  const before = { status: row.status, realmId: row.realmId }
  try {
    await prisma.quickBooksConnection.update({
      where: { id: row.id },
      data: {
        status: 'CONNECTED',
        statusReason: null,
        realmId: callback.realmId,
        secret: seal(orgId, row.legalEntityId, tokens),
        connectedAt: now,
      },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await quickBooksAuthorizer.revoke(tokens.refreshToken).catch(() => undefined)
    return fail('That QuickBooks company is already connected to another entity. Each entity needs its own company file.')
  }
  return { ok: true, id: row.id, legalEntityId: row.legalEntityId, before }
}

export type AccessToken = { ok: true; accessToken: string; realmId: string } | { ok: false; reason: string }

/**
 * A usable access token for the entity's file, refreshed when it is within
 * five minutes of expiry. Serialised per connection with an advisory lock:
 * refresh tokens rotate, so two refreshes racing on one token would leave the
 * loser holding a dead one and report a healthy connection as broken.
 */
export async function quickBooksAccessToken(legalEntityId: string, now = new Date()): Promise<AccessToken> {
  // ponytail: the provider call runs inside the transaction holding the lock.
  // Fine for one refresh an hour per entity; move the lock to a lease column
  // if refreshes ever queue behind each other.
  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quickbooks:${legalEntityId}`}))`
      const row = await tx.quickBooksConnection.findUnique({ where: { legalEntityId } })
      if (!row || row.status !== 'CONNECTED' || !row.realmId) {
        return { result: { ok: false, reason: 'QuickBooks is not connected for this entity.' } as AccessToken }
      }
      const tokens = open(row.orgId, legalEntityId, row.secret)
      if (!tokens) return { refused: row, reason: 'The stored QuickBooks credentials cannot be read.' }
      if (tokens.accessExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
        return { result: { ok: true, accessToken: tokens.accessToken, realmId: row.realmId } as AccessToken }
      }
      try {
        const next = await quickBooksAuthorizer.refresh(tokens.refreshToken)
        await tx.quickBooksConnection.update({ where: { id: row.id }, data: { secret: seal(row.orgId, legalEntityId, next) } })
        return { result: { ok: true, accessToken: next.accessToken, realmId: row.realmId } as AccessToken }
      } catch (error) {
        if (!(error instanceof QuickBooksGrantRefused)) throw error
        return { refused: row, reason: error.message }
      }
    },
    { timeout: 30_000 },
  )
  if ('result' in outcome) return outcome.result!
  await markReconnectNeeded(outcome.refused!, outcome.reason!)
  return { ok: false, reason: outcome.reason! }
}

async function markReconnectNeeded(row: { id: string; orgId: string; legalEntityId: string; realmId: string | null }, reason: string) {
  const { count } = await prisma.quickBooksConnection.updateMany({
    where: { id: row.id, status: 'CONNECTED' },
    data: { status: 'RECONNECT_NEEDED', statusReason: reason, secret: null },
  })
  if (count !== 1) return
  await auditAsSystem('quickbooks', {
    action: 'integration.reconnect_needed',
    entityType: 'QuickBooksConnection',
    entityId: row.id,
    orgId: row.orgId,
    before: { status: 'CONNECTED', realmId: row.realmId },
    after: { status: 'RECONNECT_NEEDED', reason },
  })
  // A Task needs a property: the entity's oldest active one. An entity with
  // none has nothing to sync, so nothing is waiting on the reconnect.
  const property = await prisma.property.findFirst({
    where: { legalEntityId: row.legalEntityId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, timezone: true, legalEntity: { select: { name: true } } },
  })
  if (!property) return
  await createTask(prisma, {
    propertyId: property.id,
    type: 'quickbooks_reconnect',
    subjectType: 'QuickBooksConnection',
    subjectId: row.id,
    businessDate: businessDate(new Date(), property.timezone),
    priority: 'URGENT',
    title: `QuickBooks needs reconnecting for ${property.legalEntity.name}. Nothing syncs until it is.`,
  })
}

/**
 * Revokes at Intuit and forgets the tokens and the realm. A failed revoke
 * still disconnects here: holding a token the owner asked us to drop is worse
 * than a grant they can also remove from QuickBooks' own app list.
 */
export async function disconnectQuickBooks(
  orgId: string,
  legalEntityId: string,
): Promise<{ ok: true; before: { status: string; realmId: string | null }; id: string } | { ok: false; error: string }> {
  const row = await prisma.quickBooksConnection.findFirst({ where: { legalEntityId, orgId } })
  if (!row || row.status === 'DISCONNECTED') return { ok: false, error: 'That entity is not connected to QuickBooks.' }
  const tokens = open(orgId, legalEntityId, row.secret)
  let reason: string | null = null
  if (tokens) {
    await quickBooksAuthorizer.revoke(tokens.refreshToken).catch((error: unknown) => {
      reason = `Disconnected here; QuickBooks did not confirm the revoke (${error instanceof Error ? error.message : 'unknown error'}). Remove the app in QuickBooks too.`
    })
  }
  await prisma.quickBooksConnection.update({
    where: { id: row.id },
    data: { status: 'DISCONNECTED', statusReason: reason, secret: null, realmId: null, oauthStateHash: null, oauthStartedAt: null },
  })
  return { ok: true, id: row.id, before: { status: row.status, realmId: row.realmId } }
}

export type QuickBooksRow = {
  legalEntityId: string
  entityName: string
  connection: {
    id: string
    status: string
    statusReason: string | null
    basis: AccountingBasis
    propertyField: AccountingPropertyField
    realmId: string | null
    connectedAt: Date | null
  } | null
}

/// Every active entity of the org with its connection, for the page.
export async function quickBooksRows(orgId: string): Promise<QuickBooksRow[]> {
  const entities = await prisma.legalEntity.findMany({
    where: { orgId, active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      quickBooksConnection: {
        select: { id: true, status: true, statusReason: true, basis: true, propertyField: true, realmId: true, connectedAt: true },
      },
    },
  })
  return entities.map((entity) => ({ legalEntityId: entity.id, entityName: entity.name, connection: entity.quickBooksConnection }))
}

/**
 * The simulated consent page's answer (D-27): a grant in the simulator's own
 * table for the company the owner named, and the callback URL Intuit would
 * redirect to. Cancel comes back as `access_denied`, as Intuit's does.
 */
export async function answerSimulatedConsent(
  state: string,
  answer: { approve: boolean; realmId: string },
  redirectUri: string,
): Promise<string> {
  const url = new URL(redirectUri)
  url.searchParams.set('state', state)
  if (!answer.approve) {
    url.searchParams.set('error', 'access_denied')
    return url.href
  }
  const code = token('code')
  await prisma.simulatedQuickBooksGrant.create({
    data: { realmId: answer.realmId, code, refreshToken: token('rt'), accessToken: token('at') },
  })
  url.searchParams.set('code', code)
  url.searchParams.set('realmId', answer.realmId)
  return url.href
}

/// The owner removing the app inside QuickBooks: the next refresh is refused.
export async function revokeSimulatedGrants(realmId: string): Promise<void> {
  await prisma.simulatedQuickBooksGrant.updateMany({ where: { realmId, revokedAt: null }, data: { revokedAt: new Date() } })
}

/// The org a pending consent state belongs to, or null.
export async function orgIdForQuickBooksState(state: string): Promise<string | null> {
  const row = await prisma.quickBooksConnection.findUnique({ where: { oauthStateHash: sha256(state) }, select: { orgId: true } })
  return row?.orgId ?? null
}
