// Vendor-facing copy for a link that will not open (R-025).
//
// Its OWN module, not actions.ts, because a `'use server'` file may export
// nothing but async functions - Next.js rejects a sync export at build time,
// and TypeScript cannot see that constraint, so this only surfaces when the
// production build runs. Worth a file of its own rather than an `async`
// wrapper around a lookup table that never awaits anything.

/// "Expired" and "reassigned" are genuinely different problems with
/// different fixes, and telling them apart is the difference between
/// scrolling up for a newer text and phoning the office. Every message says
/// what to DO, because a vendor reading this is standing in a driveway.
const REJECTION_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid. Check for a newer text from us, or call the office.',
  expired: 'This link has expired. Call or text the office and we will send a new one.',
  already_used: 'This link has been replaced. Look for a newer text from us.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  wrong_work_order: 'This link is not valid.',
  reassigned: 'This job has been reassigned. Thanks - nothing further is needed from you.',
  not_actionable: 'This job is closed. Thanks - nothing further is needed from you.',
}

export function vendorRejectionMessage(reason: string): string {
  return REJECTION_MESSAGES[reason] ?? REJECTION_MESSAGES.not_found!
}
