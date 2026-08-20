// Metrics with a written formula and a test (RPT-01, R-075) - collected
// here specifically for the ones with NO single tested home before this
// item: occupancy and days-to-fill were computed nowhere at all or faked
// from a function built for a different question; renewal rate and turn
// cost were correct but inline in an app-layer query; a first-response
// DURATION (as opposed to `firstResponseSlaState`'s state classification)
// and time-to-resolve-by-priority did not exist at all.
//
// THREE NAMED METRICS DELIBERATELY STAY IN THEIR OWN DOMAIN, NOT HERE:
// days-vacant (`daysOnMarket`, `@rental/core/units`), delinquency buckets
// (`bucketFor`/`delinquencyFor`/`agingTotals`, `@rental/core/ledger`), and
// `daysPastDue` (`@rental/core/money`) already had one tested, correctly
// reused definition each before this item existed - moving them here would
// be pure churn (every existing caller and test file re-pointed) for no
// behavior change, and this codebase has no precedent anywhere of one
// domain's `index.ts` re-exporting another's. "Every metric has ONE
// written, tested formula" is the rule this item satisfies (D-65, see
// 07-decisions.md); "every metric's file physically lives under
// packages/core/metrics" is not the same rule, and is not this one.

export * from './occupancy.ts'
export * from './vacancy.ts'
export * from './maintenance.ts'
export * from './leasing.ts'
export * from './turnover.ts'
