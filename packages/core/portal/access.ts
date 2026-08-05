// What a tenant may see of their own file (DOC-03, R-018).
//
// DOC-03: "As a tenant, I access my documents (lease, notices, receipts) and
// ONLY mine - enforced server-side and verified by permission tests."
//
// This is the whole security surface of the tenant portal expressed as one
// pure function, so the rule can be argued about and tested on its own rather
// than being spread across three query files where a missing `where` clause
// looks like nothing.
//
// THE RULE IS ALLOW-LIST, NOT DENY-LIST, and that direction is deliberate. A
// tenant sees a document because it NAMES them or their tenancy - never
// because it happens to live at the address they rent. Written the other way
// round ("everything at the property except the sensitive ones") every new
// document type added by a later item would default to visible, and the first
// one somebody forgot to exclude would be a leak. Written this way the
// default is invisible and the mistake is a tenant not seeing something they
// should, which they will report.
//
// Concretely, at a single property the landlord's own file contains the deed,
// the mortgage note, insurance declarations, HOA papers, warranties (R-015),
// inspection reports, unit and shutoff photos (R-012/R-014), and the LEASES OF
// EVERY OTHER TENANT who has ever lived there. Property-wide visibility would
// hand all of it over.

/// The tenancies a tenant is party to. Deliberately every lease they have
/// ever been on, not only live ones: a former tenant still needs their own
/// lease and their deposit-disposition paperwork, which is exactly the
/// evidence a deposit dispute turns on.
export interface TenantScope {
  tenantId: string
  leaseIds: readonly string[]
}

/// The subset of a Document this decision needs. Structural rather than the
/// Prisma type, so the rule can be tested without a database and cannot
/// accidentally start depending on a field it should not.
export interface DocumentAccessFacts {
  tenantId: string | null
  leaseId: string | null
  /// Soft-deleted documents (DOC-05's 30-day undelete window) are landlord
  /// bookkeeping. A tenant must not see one: from their side it was withdrawn,
  /// and showing it would leak the fact that it briefly existed.
  deletedAt: Date | null
}

/**
 * Whether this tenant may read this document.
 *
 * Two ways in, and only two:
 *
 *   The document names them directly (`tenantId`) - their ID, their signed
 *   application, a notice addressed to them.
 *
 *   The document belongs to a tenancy they are on (`leaseId`) - the lease
 *   itself, its addenda, a deposit disposition.
 *
 * Notably NOT `propertyId` or `unitId`, however tempting: those are the
 * landlord's operational records and, at a multi-unit property, other
 * people's. A move-in condition report is the one thing a tenant arguably
 * should see that this rule excludes today - it hangs off the inspection, and
 * INSP is R-070's. Whichever item builds it adds a third clause here, in one
 * place, with a test.
 */
export function tenantCanSeeDocument(
  document: DocumentAccessFacts,
  scope: TenantScope,
): boolean {
  if (document.deletedAt !== null) return false
  if (document.tenantId !== null && document.tenantId === scope.tenantId) {
    return true
  }
  if (document.leaseId !== null && scope.leaseIds.includes(document.leaseId)) {
    return true
  }
  return false
}
