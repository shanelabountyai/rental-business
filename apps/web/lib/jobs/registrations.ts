import 'server-only'

// The one place that imports every scheduled-job module for its side effect
// (each module pushes itself into R-006's `SCHEDULED_JOBS` on import). R-006
// shipped that array empty with the expectation that "the items that own the
// nightly work register here" - this file is where "here" actually is.
//
// Import ONLY from this file (the cron route does). A job module imported
// from two different places would register itself twice under two different
// module instances, which is invisible until the job runs twice a tick.
//
// Side-effect imports, so nothing is re-exported - `import` alone is the
// point.
import '../units/auto-make-ready.ts'
