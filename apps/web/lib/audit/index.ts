import 'server-only'

import {
  type AuditActor,
  type AuditDb,
  type AuditEntry,
  recordAudit,
} from '@rental/core/audit'
import { prisma } from '@rental/db'
import type { Session } from 'next-auth'
import { headers } from 'next/headers'
import { auth } from '@/auth.ts'
import { hostOrgId } from '@/lib/auth/org.ts'
import { isPlatformHost } from '@/lib/auth/platform-host.ts'

// Request-aware wrapper around the shared audit service.
//
// packages/core/audit knows how to write an entry; this knows who is asking
// and from where. Splitting them is what lets a background job (R-006) record
// audit entries with a SYSTEM actor and no request at all, using the same
// writer and the same redaction.

/// Resolves the current principal into an audit actor, including the request
/// metadata that makes an entry useful in a dispute.
export async function currentAuditActor(): Promise<AuditActor> {
  return (await requestAuditContext()).actor
}

/// The actor and the session's org from ONE `auth()`, which re-reads the
/// principal from the database every time it is called.
async function requestAuditContext(): Promise<{ actor: AuditActor; orgId?: string }> {
  const [session, headerList] = await Promise.all([auth(), headers()])
  // The console's session is a different cookie read by a different Auth.js
  // instance, so the org `auth()` above sees nobody there (PRD 11 §5.4,
  // R-294c). Only on the console's host, so no org request pays the lookup,
  // and imported there only: a static import loads a second Auth.js into
  // every module that audits, which unit tests mocking `@/auth.ts` cannot.
  if (!session?.principal && isPlatformHost(headerList.get('host'))) {
    const { currentPlatformPrincipal } = await import('@/platform-auth.ts')
    const admin = await currentPlatformPrincipal()
    if (admin) return { actor: { ...requestMeta(headerList), type: 'PLATFORM', ref: admin.id } }
  }
  const orgId = session?.principal?.orgId || undefined
  return { actor: actorFor(session, headerList), orgId }
}

function requestMeta(headerList: Pick<Headers, 'get'>) {
  return {
    ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: headerList.get('user-agent'),
  }
}

function actorFor(session: Session | null, headerList: Pick<Headers, 'get'>): AuditActor {
  const { ipAddress, userAgent } = requestMeta(headerList)

  if (!session?.principal) {
    return { type: 'SYSTEM', ref: 'anonymous', ipAddress, userAgent }
  }

  if (session.principal.kind === 'staff') {
    return {
      type: 'STAFF',
      staffUserId: session.principal.id,
      ipAddress,
      userAgent,
    }
  }

  // A guarantor was recorded as TENANT until R-294a, which said "the renter
  // did this" about someone who was never a party to the tenancy.
  return {
    type: session.principal.kind === 'guarantor' ? 'GUARANTOR' : 'TENANT',
    ref: session.principal.id,
    ipAddress,
    userAgent,
  }
}

/// An entry as `audit()` takes it: the org may be left out, because the
/// request knows it.
export type RequestAuditEntry = Omit<AuditEntry, 'propertyId' | 'orgId'> & {
  propertyId?: string | null
  orgId?: string
}

/**
 * Records an entry attributed to whoever is making the current request.
 *
 * Pass `db` when the action runs in a transaction - which it should, so the
 * entry and the change it describes are atomic. See record.ts for why that
 * matters more than it looks.
 */
export async function audit(
  input: RequestAuditEntry,
  db: AuditDb = prisma,
): Promise<void> {
  const context = await requestAuditContext()
  // With no property and no org named, the entry is in the org this request
  // acts in: the session's, which R-288 holds equal to the host's, or the
  // host's for an anonymous caller (a public form). Null only on a host that
  // names no org, where the CHECK refuses the row - loud, not misfiled.
  const orgId = input.propertyId
    ? input.orgId
    : (input.orgId ?? context.orgId ?? (await hostOrgId()) ?? undefined)
  await recordAudit(db, { ...input, orgId, actor: context.actor } as Parameters<typeof recordAudit>[1])
}

/// Re-exported for the callers that already had it from here. New callers
/// that do NOT need a request - a job, a webhook - should import it from
/// './system.ts' directly: this module pulls in Auth.js, which cannot load
/// outside a request context. See system.ts's own comment.
export { auditAsSystem, auditAsVendor } from './system.ts'

export { auditTrailFor } from '@rental/core/audit'
