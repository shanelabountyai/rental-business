import { isAuthorizedCron } from '@/lib/cron/authorize.ts'
import { dispatchPendingNotifications } from '@/lib/notifications/send.ts'

// Hourly: release what is due (R-261). `/api/cron` runs once a day at 16:00
// UTC, which was fine for nightly jobs and wrong for anything with a time on
// it - a quiet-hours hold due at 08:00 local went out at 10:00 or 11:00
// Central, and a scheduled announcement for 9am would have too. This route
// does one thing, so a slow nightly job cannot delay a timed send.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return new Response('Not found', { status: 404 })

  const notifications = await dispatchPendingNotifications()
  return Response.json({ ok: true, ...notifications })
}
