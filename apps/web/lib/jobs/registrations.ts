import 'server-only'

// The one place that imports every scheduled-job module for its side effect
// (each module pushes itself into R-006's `SCHEDULED_JOBS` on import, and
// every outbox consumer pushes itself into `CONSUMERS` the same way). R-006
// shipped both arrays empty with the expectation that "the items that own the
// nightly work register here" - this file is where "here" actually is.
//
// Import ONLY from this file (the cron route does). A job or consumer module
// imported from two different places would register itself twice under two
// different module instances, which is invisible until the job runs twice a
// tick or the tenant gets two texts.
//
// Side-effect imports, so nothing is re-exported - `import` alone is the
// point.
import '../billing/card-expiry-job.ts'
import '../billing/due-notices-job.ts'
import '../billing/predebit-job.ts'
import '../billing/sweep-job.ts'
import '../ledger/late-fee-job.ts'
import '../listings/delist-consumer.ts'
import '../maintenance/triage-consumer.ts'
import '../notifications/consumers.ts'
import '../notifications/digest-job.ts'
import '../units/auto-make-ready.ts'
import '../workorders/job-consumer.ts'
