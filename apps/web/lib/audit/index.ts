import 'server-only'

import {
  type AuditActor,
  type AuditDb,
  type AuditInput,
  recordAudit,
} from '@rental/core/audit'
import { prisma } from '@rental/db'
import { headers } from 'next/headers'
import { auth } from '@/auth.ts'

// Request-aware wrapper around the shared audit service.
//
// packages/core/audit knows how to write an entry; this knows who is asking
// and from where. Splitting them is what lets a background job (R-006) record
// audit entries with a SYSTEM actor and no request at all, using the same
// writer and the same redaction.

/// Resolves the current principal into an audit actor, including the request
/// metadata that makes an entry useful in a dispute.
export async function currentAuditActor(): Promise<AuditActor> {
  const [session, headerList] = await Promise.all([auth(), headers()])

  const ipAddress =
    headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const userAgent = headerList.get('user-agent')

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

  return {
    type: 'TENANT',
    ref: session.principal.id,
    ipAddress,
    userAgent,
  }
}

/**
 * Records an entry attributed to whoever is making the current request.
 *
 * Pass `db` when the action runs in a transaction - which it should, so the
 * entry and the change it describes are atomic. See record.ts for why that
 * matters more than it looks.
 */
export async function audit(
  input: Omit<AuditInput, 'actor'>,
  db: AuditDb = prisma,
): Promise<void> {
  await recordAudit(db, { ...input, actor: await currentAuditActor() })
}

/// Re-exported for the callers that already had it from here. New callers
/// that do NOT need a request - a job, a webhook - should import it from
/// './system.ts' directly: this module pulls in Auth.js, which cannot load
/// outside a request context. See system.ts's own comment.
export { auditAsSystem } from './system.ts'

export { auditTrailFor } from '@rental/core/audit'
