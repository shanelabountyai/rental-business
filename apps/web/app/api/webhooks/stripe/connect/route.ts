import { handleStripeWebhook } from '@/lib/billing/webhook-route.ts'
import { orgIdForStripeAccount } from '@/lib/integrations/store.ts'

// The CONNECT webhook (R-277a, D-316, PRD 10 §2.4): one endpoint and one
// signing secret for every connected account's events. `event.account` names
// the account, the account names the org, and the org scopes every lookup the
// pipeline makes - Stripe ids are unique per account, not globally.
//
// An event for an account no org holds is acknowledged and dropped rather
// than retried: guessing an org would book money against the wrong
// landlord, and Stripe retrying will not make the account appear.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handleStripeWebhook(request, process.env.STRIPE_CONNECT_WEBHOOK_SECRET, async (event) => {
    if (!event.account) return { ignore: 'no account on a Connect event' }
    const orgId = await orgIdForStripeAccount(event.account)
    return orgId ? { orgId } : { ignore: `no org holds account ${event.account}` }
  })
}
