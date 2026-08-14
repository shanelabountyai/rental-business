import 'server-only'

import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { sendPredebitNotices } from './predebit.ts'

// The daily T-2 pre-debit sweep (PAY-02, R-039a; D-3).
//
// 7am local, an hour after the late-fee assessment. A notice telling somebody
// money is about to leave their account should not arrive at 3am, and running
// it per property in local time is what D-3 requires rather than what is
// tidy: "is it two days before the 1st" has a different answer in three
// timezones.
const LOCAL_HOUR = 7

SCHEDULED_JOBS.push({
  type: 'billing.predebit_notices',
  localHour: LOCAL_HOUR,
  description:
    'Warns every autopay payer whose rent falls due in two days, in the property\'s own local time (PAY-02).',
  run: async ({ propertyId }) => {
    const result = await sendPredebitNotices(propertyId)
    return { leasesChecked: result.leasesChecked, noticesSent: result.noticesSent }
  },
})
