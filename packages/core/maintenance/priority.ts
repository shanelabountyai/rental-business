// Suggested priority at intake (MAINT-02, R-023).
//
// "Suggested" is the operative word - submitMaintenanceRequest's own comment
// already put it plainly: "a category is weak evidence for priority." This
// gives every new ticket a real, non-default starting point instead of
// sitting at the schema's ROUTINE default regardless of what it's about, but
// a PM can always override it during triage. Category alone never reaches
// EMERGENCY - that word is earned only through R-020's own emergency intake,
// where the tenant read a real warning and chose it deliberately.

import type { MaintenanceCategory } from './categories.ts'

/// Categories where a delay carries real cost - water damage, an electrical
/// hazard, no climate control in Texas, a compromised lock - default to
/// URGENT. The rest default to ROUTINE. Neither is a promise; it is a
/// starting point a PM reads and, usually within seconds, either accepts or
/// overrides.
const URGENT_BY_DEFAULT: ReadonlySet<MaintenanceCategory> = new Set([
  'PLUMBING',
  'ELECTRICAL',
  'HVAC',
  'LOCKS',
])

export function suggestTicketPriority(input: {
  /// Not typed as MaintenanceCategory: an SMS ticket's category is
  /// UNCATEGORIZED (R-021), which is a valid input here and simply falls
  /// through to the ROUTINE default.
  category: string
  /// RISK-05's auto-elevation: habitability language overrides the
  /// category-based default outright, never the other way around - a "pest"
  /// ticket that mentions an infestation is not routine because pests
  /// usually are.
  habitabilityFlag: boolean
}): 'URGENT' | 'ROUTINE' {
  if (input.habitabilityFlag) return 'URGENT'
  return URGENT_BY_DEFAULT.has(input.category as MaintenanceCategory)
    ? 'URGENT'
    : 'ROUTINE'
}
