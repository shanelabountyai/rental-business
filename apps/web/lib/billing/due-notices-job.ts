import 'server-only'

import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { sendDueNotices } from './due-notices.ts'

// The daily due-soon (T-3) / due-date sweep (PAY-02, R-045; D-3).
//
// 7am local, alongside `billing.predebit_notices` - both are "money is about
// to be due" reminders, split by whether the tenant or the product does the
// paying. Running per property in its own local morning is D-3, not tidiness:
// "is rent due in three days" has a different answer in three timezones.

const LOCAL_HOUR = 7

SCHEDULED_JOBS.push({
  type: 'billing.due_notices',
  localHour: LOCAL_HOUR,
  description:
    'Warns every non-autopay payer whose rent is due in three days or due today, in the property\'s own local time (PAY-02).',
  // `now` from the context, never the wall clock (R-190): "due in three
  // days" is a question about the business date being run, so a caught-up
  // day sends the notice that day owed, a day late, rather than today's.
  run: async ({ propertyId, now }) => {
    const result = await sendDueNotices(propertyId, now)
    return {
      leasesChecked: result.leasesChecked,
      dueSoonSent: result.dueSoonSent,
      dueTodaySent: result.dueTodaySent,
      heldPayers: result.heldPayers,
    }
  },
})
