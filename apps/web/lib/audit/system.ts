import 'server-only'

import { type AuditDb, type AuditInput, recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'

// The request-less half of the audit wrapper.
//
// Deliberately its OWN module rather than living beside `audit()` in
// index.ts, and the reason is import-time rather than aesthetic: index.ts
// imports `auth()` from Auth.js to resolve the current principal, and
// Auth.js cannot load outside a request context - so anything importing
// index.ts, even purely for `auditAsSystem`, breaks under Vitest and drags a
// session dependency into code that has no session by definition. R-008 hit
// the same wall with guard.ts and solved it the same way (see
// lib/properties/queries.ts's own comment).
//
// index.ts's header already made this claim - "splitting them is what lets a
// background job record audit entries with a SYSTEM actor and no request at
// all" - and R-021 is where the file layout finally matches it, because an
// inbound webhook is exactly that case: a real, authenticated write with
// nobody signed in.

/// For jobs and webhooks, which have no request and no session. `ref` names
/// the job or endpoint so an entry can be traced back to what produced it.
export async function auditAsSystem(
  ref: string,
  input: Omit<AuditInput, 'actor'>,
  db: AuditDb = prisma,
): Promise<void> {
  await recordAudit(db, { ...input, actor: { type: 'SYSTEM', ref } })
}

/**
 * For a vendor acting through a magic link (D-6, R-025), which has no
 * session because a vendor has no account at all.
 *
 * NOT `auditAsSystem` with a vendor id in `ref`: a vendor is a real,
 * identified external party who accepted a job and opened a gate code, and
 * the evidence trail has to say so in the column a query filters on. Folding
 * them into SYSTEM would make "show me everything this vendor touched"
 * unanswerable without string-matching a free-text field - and that question
 * is exactly what gets asked after a break-in.
 */
export async function auditAsVendor(
  vendorId: string,
  input: Omit<AuditInput, 'actor'>,
  db: AuditDb = prisma,
): Promise<void> {
  await recordAudit(db, { ...input, actor: { type: 'VENDOR', ref: vendorId } })
}
