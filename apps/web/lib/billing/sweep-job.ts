import 'server-only'

import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { runBillingSweep } from './lifecycle.ts'

// The daily billing run (D-11, R-036).
//
// A SCHEDULED_JOBS entry, per property, per property-local day - NOT a call
// on the hourly cron tick.
//
// It was hourly first, which was wrong by a factor of twenty-four. A
// subscription drifts from its lease when somebody changes the rent or ends
// the tenancy, and both of those already trigger an immediate sync at the
// moment they happen (see lib/leases/actions.ts). This sweep is the SAFETY
// NET for the case where that immediate call failed - a provider outage, a
// timeout - and a safety net does not need to run every hour. What it does
// need is to not become the slowest thing in the nightly job, because a
// cron that takes minutes is a cron somebody eventually disables.
//
// Per-property is the other half of that: R-006's runner already gives each
// property its own local-time slot and its own already-ran guard, so a
// portfolio spanning three timezones sweeps three times rather than once
// against everything.

const LOCAL_HOUR = 4

SCHEDULED_JOBS.push({
  type: 'billing.sweep',
  localHour: LOCAL_HOUR,
  description:
    "Makes each Stripe subscription agree with its lease - the safety net for a sync that failed when the lease actually changed (D-11).",
  // THE ONE JOB THAT TAKES NO DATE, AND THAT IS NOT AN OVERSIGHT (R-190).
  //
  // Every other job in the registry was passed the real clock alongside a
  // historical `businessDate` on a caught-up day and did the wrong day's
  // work; the fix was to read `context.now`. This one has no day to be wrong
  // about. `runBillingSweep` reads no date at all - it makes each live
  // subscription agree with the lease AS IT IS NOW, and there is no
  // as-of-yesterday version of that question to ask. Replaying a missed date
  // therefore performs the convergence late rather than for the wrong day,
  // and the run row saying SUCCEEDED for that date is honest.
  //
  // So do not "fix" this by threading `now` in. If a date-dependent decision
  // ever moves into the sweep, it must take `context.now` like everything
  // else, and this comment has to go with it.
  run: async ({ propertyId }) => {
    const result = await runBillingSweep({ propertyIds: [propertyId] })
    return {
      checked: result.checked,
      changed: result.changed,
      failed: result.failed,
    }
  },
})
