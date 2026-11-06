import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { handleStripeWebhook } from '@/lib/billing/webhook-route.ts'
import { orgIdForStripeAccount } from '@/lib/integrations/store.ts'

// The PLATFORM account's webhook (D-11, R-034): org #0's events, since the
// env credentials are org #0's alone (D-362), and R-296's platform billing
// later. Verification and the pipeline are in lib/billing/webhook-route.ts.
//
// AN EVENT NAMING A CONNECTED ACCOUNT IS NOT ORG #0'S. It belongs on the
// Connect endpoint (./connect), and projecting it here would book another
// org's money into org #0's ledger.
//
// EXCEPT THE PLATFORM FEE (R-277b). An application fee is the platform's own
// object, so `application_fee.created` and `.refunded` arrive HERE with no
// `event.account`; the connected account it came out of is on the fee, and
// names the org.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handleStripeWebhook(request, process.env.STRIPE_WEBHOOK_SECRET, async (event) => {
    if (event.account) return { ignore: `connected account ${event.account} on the platform endpoint` }
    if (!event.type.startsWith('application_fee.')) return { orgId: DEFAULT_ORG_ID }
    const account = event.data?.object?.account
    const orgId = typeof account === 'string' ? await orgIdForStripeAccount(account) : null
    return orgId ? { orgId } : { ignore: `no org holds the fee's account ${String(account)}` }
  })
}
