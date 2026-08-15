import 'server-only'

import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { sendCardExpiringNotices } from './card-expiry.ts'

// The daily card-expiring-soon sweep (PAY-02, R-045; D-3).
//
// 8am local, after the other money-related morning jobs - this one is
// informational rather than time-critical (a card expiring within a month
// can wait a slot behind rent actually being due today), and it is the
// reason the backlog names it separately: it keeps a long-tenured,
// always-on-time tenant out of the dunning ladder over something visible a
// month ahead, rather than reacting to the failed charge after the fact.

const LOCAL_HOUR = 8

SCHEDULED_JOBS.push({
  type: 'billing.card_expiring_notices',
  localHour: LOCAL_HOUR,
  description:
    'Warns every autopay payer whose saved card expires within thirty days, read live from the billing provider (PAY-02).',
  run: async ({ propertyId }) => {
    const result = await sendCardExpiringNotices(propertyId)
    return { payersChecked: result.payersChecked, noticesSent: result.noticesSent }
  },
})
