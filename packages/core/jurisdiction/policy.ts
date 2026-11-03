// R-298b (PRD 10 §7.2, D-390): an org's own policy on top of the statute,
// STRICTER ONLY. An org may give more grace, cap a late fee lower, give
// longer entry notice - never the reverse, so a policy row cannot make the
// product do something the statute forbids. D-12 holds: this is still core
// deciding the number Stripe is told.
//
// A null statute number is "not configured", and a policy fills it: a promise
// the org has made is enforceable whether or not the statute has been taught.

export interface OrgPolicyLike {
  policyGraceDays: number | null
  policyLateFeeMaxCents: number | null
  policyEntryNoticeHours: number | null
}

export interface PolicyGovernedRule {
  graceDays: number
  lateFeeMaxCents: number | null
  entryNoticeHours: number | null
}

export type PolicyField = keyof PolicyGovernedRule

/// The fields where the policy, not the statute, set the number - so a
/// message can say "your policy" rather than claim the law requires it.
export type WithPolicy<T> = T & { policyApplied: PolicyField[] }

export function applyOrgPolicy<T extends PolicyGovernedRule>(
  rule: T,
  policy: OrgPolicyLike | null,
): WithPolicy<T> {
  const policyApplied: PolicyField[] = []
  const merged = { ...rule, policyApplied }
  if (!policy) return merged

  const longer = (statute: number | null, own: number | null) =>
    own != null && (statute == null || own > statute)

  if (longer(rule.graceDays, policy.policyGraceDays)) {
    merged.graceDays = policy.policyGraceDays!
    policyApplied.push('graceDays')
  }
  if (
    policy.policyLateFeeMaxCents != null &&
    (rule.lateFeeMaxCents == null || policy.policyLateFeeMaxCents < rule.lateFeeMaxCents)
  ) {
    merged.lateFeeMaxCents = policy.policyLateFeeMaxCents
    policyApplied.push('lateFeeMaxCents')
  }
  if (longer(rule.entryNoticeHours, policy.policyEntryNoticeHours)) {
    merged.entryNoticeHours = policy.policyEntryNoticeHours
    policyApplied.push('entryNoticeHours')
  }
  return merged
}
