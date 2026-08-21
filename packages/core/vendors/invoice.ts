// Vendor invoice status - "received → approved → paid" (MAINT-09, R-079),
// the status a VENDOR sees on their own portal so they stop calling to ask
// "where's my check".
//
// ONLY "PAID" IS A REAL STORED FACT. "Received" and "approved for payment"
// are both derivable from data this product already has - `Vendor.invoiceCents`
// being set, and whether the job is inside the entity's own tolerance
// (`packages/core/workorders`' `closeDecision()`/`reapprovalCheck()`, not a
// second copy of that logic). Storing a redundant "status" column would be
// one more place for the two to disagree.

// Three real stages, not the four "received / approved / paid" might
// suggest: an in-tolerance invoice auto-routes straight to `'approved'` the
// moment it exists (that IS the tolerance-based auto-routing MAINT-09 asks
// for - no separate "received but not yet reviewed" state to sit in when
// nothing is actually being reviewed). Only an over-tolerance invoice ever
// stops at an intermediate stage, waiting on a human.
export type InvoiceLifecycleStatus = 'not_received' | 'needs_approval' | 'approved' | 'paid'

export interface InvoiceLifecycleFacts {
  invoiceCents: number | null
  /// From `reapprovalCheck()` (`packages/core/approvals`) - true when the
  /// actual cost exceeds what was approved and a PM has to sign off on the
  /// difference before this invoice is payable. The SAME computation
  /// `closeDecision()`'s own `overApproved` flag reads, not re-derived here.
  overTolerance: boolean
  invoicePaidAt: Date | null
}

export function invoiceLifecycleStatus(facts: InvoiceLifecycleFacts): InvoiceLifecycleStatus {
  if (facts.invoicePaidAt) return 'paid'
  if (facts.invoiceCents == null) return 'not_received'
  if (facts.overTolerance) return 'needs_approval'
  return 'approved'
}

export const INVOICE_STATUS_LABELS: Record<InvoiceLifecycleStatus, string> = {
  not_received: 'Invoice not received yet',
  needs_approval: 'Invoice exceeds the approved amount — pending PM review',
  approved: 'Approved for payment',
  paid: 'Paid',
}

/// IRS Form 1099-NEC's own reporting threshold - a federal figure, not
/// jurisdiction (state/local) configuration, so D-4's "never hardcode a
/// jurisdiction-dependent number" does not apply the way it does to a grace
/// period or a notice-hours rule. Still a plain literal rather than
/// buried inline: Congress has changed this number before and could again,
/// and one named constant is the single place to update it.
export const FORM_1099_THRESHOLD_CENTS = 60_000

export function requiresForm1099(totalPaidCents: number): boolean {
  return totalPaidCents >= FORM_1099_THRESHOLD_CENTS
}
