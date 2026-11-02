import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { handleStripeWebhook } from '@/lib/billing/webhook-route.ts'

// The PLATFORM account's webhook (D-11, R-034): org #0's events, since the
// env credentials are org #0's alone (D-362), and R-296's platform billing
// later. Verification and the pipeline are in lib/billing/webhook-route.ts.
//
// AN EVENT NAMING A CONNECTED ACCOUNT IS NOT ORG #0'S. It belongs on the
// Connect endpoint (./connect), and projecting it here would book another
// org's money into org #0's ledger.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return handleStripeWebhook(request, process.env.STRIPE_WEBHOOK_SECRET, async (event) =>
    event.account
      ? { ignore: `connected account ${event.account} on the platform endpoint` }
      : { orgId: DEFAULT_ORG_ID },
  )
}
