import 'server-only'

import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { assessLateFees } from './late-fees.ts'

// The nightly late-fee assessment (PAY-04, R-040).
//
// PER PROPERTY, IN ITS OWN LOCAL MORNING, which D-3 makes mandatory rather
// than tidy: whether rent is late is a question about a calendar day in the
// property's timezone, and a portfolio spanning three timezones has three
// different answers to "is it the 4th yet". Running this at UTC midnight
// would assess a Texas tenant while it was still the 3rd for them.
//
// 6am local, after the 4am billing sweep. Ordering matters slightly: the
// sweep is what makes Stripe agree with the lease, and assessing a fee
// against a subscription that should have been cancelled is a fee somebody
// has to reverse. It is not a hard dependency - the assessment reads charges
// and leases, not subscriptions - but there is no reason to run it first.

const LOCAL_HOUR = 6

SCHEDULED_JOBS.push({
  type: 'ledger.late_fees',
  localHour: LOCAL_HOUR,
  description:
    'Assesses late fees on overdue rent from versioned jurisdiction config, clamped to the statutory cap, and pushes each one to Stripe as an invoice item (D-4, D-12).',
  run: async ({ propertyId }) => {
    const result = await assessLateFees(propertyId)
    return {
      leasesChecked: result.leasesChecked,
      chargesAssessed: result.chargesAssessed,
      assessedCents: result.assessedCents,
      failed: result.failed,
    }
  },
})
