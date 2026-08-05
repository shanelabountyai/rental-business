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
  /**
   * The units those leases are on. Added at R-020 for exactly one purpose -
   * the safety exception below - and used for nothing else.
   *
   * Optional so every existing caller keeps compiling and keeps its current
   * behaviour: an absent list means the safety exception simply cannot
   * match, which is the safe direction for a field whose only job is to
   * widen access.
   */
  unitIds?: readonly string[]
}

/// The subset of a Document this decision needs. Structural rather than the
/// Prisma type, so the rule can be tested without a database and cannot
/// accidentally start depending on a field it should not.
export interface DocumentAccessFacts {
  tenantId: string | null
  leaseId: string | null
  /// Added at R-020 for the shutoff-photo safety exception. Null for every
  /// document not attached to a unit.
  unitId?: string | null
  /// Added at R-020 for the same reason - the exception is keyed on the
  /// document CLASS, not merely on where it lives.
  type?: string | null
  /// Soft-deleted documents (DOC-05's 30-day undelete window) are landlord
  /// bookkeeping. A tenant must not see one: from their side it was withdrawn,
  /// and showing it would leak the fact that it briefly existed.
  deletedAt: Date | null
}

/**
 * The one document class a tenant may see purely because of WHERE it is
 * rather than whose name is on it (R-020).
 *
 * MAINT-01 requires that an emergency intake "displays the relevant shutoff
 * photo/location from the unit record". That photo is attached to the unit
 * (R-014), not to the tenant or the lease, so the allow-list above would
 * refuse it - and refusing to show somebody standing in rising water where
 * their own stop tap is would be the wrong answer to a safety question.
 *
 * Kept to a single named type rather than a general "unit documents are
 * visible" rule, because the unit record ALSO holds the versioned condition
 * photo library (PROP-08) - including photos from previous tenancies of the
 * same home, which are emphatically not this tenant's to see.
 */
const UNIT_SAFETY_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['SHUTOFF_PHOTO'])

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
 * ...plus, since R-020, exactly one narrow safety exception: a SHUTOFF_PHOTO
 * on a unit they hold a lease on. See UNIT_SAFETY_DOCUMENT_TYPES for why that
 * is one named type and not "unit documents".
 *
 * Notably still NOT `propertyId`, and not `unitId` in general, however
 * tempting: those are the landlord's operational records and, at a
 * multi-unit property, other people's. A move-in condition report is the one
 * thing a tenant arguably should see that this rule still excludes - it
 * hangs off the inspection, and INSP is R-070's. Whichever item builds it
 * adds its clause here, in one place, with a test.
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
  if (
    document.type != null &&
    UNIT_SAFETY_DOCUMENT_TYPES.has(document.type) &&
    document.unitId != null &&
    scope.unitIds?.includes(document.unitId)
  ) {
    return true
  }
  return false
}
