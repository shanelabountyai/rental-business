import { formatCents } from '../money/index.ts'

// Listing disclosures (LEASE-01, R-056; D-4): "jurisdictions with required
// listing disclosures (deposit amount, fee limits, voucher/source-of-income
// acceptance)."
//
// COMPUTED, NEVER STORED. A listing is a live page, not a signed document -
// see Listing's own schema comment - so this reads whatever the property's
// JurisdictionRule says RIGHT NOW rather than freezing a fact at publish
// time that could go stale the next time the rule is reviewed.
//
// Every branch says something, including the honest gap. A disclosure
// screen that goes silent when a number is unconfigured reads as "nothing
// applies here", which is the specific compliance failure D-4 exists to
// prevent - the same reasoning R-051's servicePermitted() and R-055's
// retaliationWarning() already apply to their own null cases.

export interface JurisdictionDisclosureInput {
  state: string
  depositMaxBps: number | null
  applicationFeeCapCents: number | null
  /// Null means unreviewed - see the schema's own comment on this column.
  /// Unlike depositMaxBps/applicationFeeCapCents above, which have carried
  /// an ambiguous null ("no cap" vs "not reviewed") since R-010, this field
  /// was given a genuine three-state meaning from the start, so the null
  /// branch below can say "not reviewed" without overclaiming.
  sourceOfIncomeProtected: boolean | null
}

export interface ListingDisclosure {
  label: string
  text: string
}

export function listingDisclosures(rule: JurisdictionDisclosureInput): ListingDisclosure[] {
  return [
    {
      label: 'Security deposit',
      text:
        rule.depositMaxBps != null
          ? `${rule.state} caps the security deposit at ${(rule.depositMaxBps / 100).toFixed(0)}% of one month's rent.`
          : `No statutory security-deposit cap is on file for ${rule.state}.`,
    },
    {
      label: 'Application fee',
      text:
        rule.applicationFeeCapCents != null
          ? `${rule.state} caps the application fee at ${formatCents(rule.applicationFeeCapCents)}.`
          : `No statutory application-fee cap is on file for ${rule.state}.`,
    },
    {
      label: 'Source of income',
      text:
        rule.sourceOfIncomeProtected === true
          ? `${rule.state} treats source of income, including housing vouchers, as a protected class. This property considers all lawful sources of income.`
          : rule.sourceOfIncomeProtected === false
            ? `${rule.state} does not require acceptance of a specific source of income for this property.`
            : `Whether ${rule.state} protects source of income has not been reviewed for this property.`,
    },
  ]
}
