// `/platform/settings` (PRD 11 §4.12, R-303b): the deployment's switches as
// on / off / set / unset. Read-only, because a switch that needs the database
// cannot stop a database incident (D-347). A SECRET'S VALUE NEVER LEAVES THIS
// FUNCTION: only the hostnames, `VERCEL_ENV` and the commit SHA are shown as
// themselves, and the Stripe key only as the mode its prefix names.

export type SettingLine = { name: string; shown: string; does: string; where: string }

const VERCEL = 'Vercel → Project → Settings → Environment Variables'

const setOrNot = (v: string | undefined) => (v ? 'set' : 'unset')

export function platformSettings(env: Record<string, string | undefined>): SettingLine[] {
  const value = (name: string) => env[name]?.trim() || undefined
  const stripe = value('STRIPE_SECRET_KEY')
  return [
    {
      name: 'NOTIFICATIONS_ENABLED',
      // Exactly the reader's test (lib/notifications/config.ts), untrimmed.
      shown: env.NOTIFICATIONS_ENABLED === 'false' ? 'off' : 'on',
      does: 'The global kill switch. Off holds every outbound email and text for every organisation.',
      where: VERCEL,
    },
    {
      name: 'NOTIFICATIONS_SANDBOX_TO',
      shown: setOrNot(value('NOTIFICATIONS_SANDBOX_TO')),
      does: 'When set, every outbound message is redirected to this one address or number.',
      where: VERCEL,
    },
    { name: 'ORG_BASE_DOMAIN', shown: value('ORG_BASE_DOMAIN') ?? 'unset', does: 'The domain each organisation’s subdomain hangs off.', where: VERCEL },
    { name: 'PLATFORM_HOST', shown: value('PLATFORM_HOST') ?? 'unset', does: 'The host this console answers on. Unset, the console does not exist.', where: VERCEL },
    {
      name: 'DEMO_ACCESS_PASSWORD',
      shown: setOrNot(value('DEMO_ACCESS_PASSWORD')),
      does: 'When set, every page asks for the shared demo password first.',
      where: VERCEL,
    },
    { name: 'CRON_SECRET', shown: setOrNot(value('CRON_SECRET')), does: 'Authorises Vercel Cron and this console’s re-run. Unset, no scheduled job runs.', where: VERCEL },
    {
      name: 'STRIPE_SECRET_KEY',
      shown: !stripe ? 'unset (simulator)' : stripe.startsWith('sk_live_') || stripe.startsWith('rk_live_') ? 'live mode' : 'test mode',
      does: 'Which Stripe account money moves through. Unset uses the simulator.',
      where: VERCEL,
    },
    { name: 'STRIPE_WEBHOOK_SECRET', shown: setOrNot(value('STRIPE_WEBHOOK_SECRET')), does: 'Verifies Stripe’s webhooks, which build the ledger.', where: VERCEL },
    { name: 'TWILIO_AUTH_TOKEN', shown: setOrNot(value('TWILIO_AUTH_TOKEN')), does: 'Sends texts and verifies Twilio’s callbacks.', where: VERCEL },
    { name: 'RESEND_WEBHOOK_SECRET', shown: setOrNot(value('RESEND_WEBHOOK_SECRET')), does: 'Verifies Resend’s delivery webhooks.', where: VERCEL },
    { name: 'INBOUND_EMAIL_SECRET', shown: setOrNot(value('INBOUND_EMAIL_SECRET')), does: 'Authorises inbound email. Unset, the route refuses everything.', where: VERCEL },
    { name: 'AUTH_SECRET', shown: setOrNot(value('AUTH_SECRET')), does: 'Signs every session and seals stored secrets. Rotating it signs everyone out.', where: VERCEL },
    { name: 'VERCEL_ENV', shown: value('VERCEL_ENV') ?? 'unset (not on Vercel)', does: 'Which Vercel environment this is.', where: 'Set by Vercel' },
    {
      name: 'VERCEL_GIT_COMMIT_SHA',
      shown: value('VERCEL_GIT_COMMIT_SHA')?.slice(0, 7) ?? 'unset (not on Vercel)',
      does: 'The commit this deployment was built from.',
      where: 'Set by Vercel',
    },
  ]
}
