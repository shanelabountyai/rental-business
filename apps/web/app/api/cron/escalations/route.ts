import { sweepEmergencyEscalations } from '@/lib/maintenance/escalation.ts'
import { isAuthorizedCron } from '@/lib/cron/authorize.ts'

// The five-minute tick (NOTIF-05, R-029).
//
// SEPARATE FROM /api/cron ON PURPOSE. That one is hourly and measures
// calendar days - late fees, renewals, entry reminders. NOTIF-05 asks for an
// emergency to escalate fifteen minutes after nobody acknowledged it, and an
// hourly tick cannot detect fifteen minutes: an emergency reported at 09:05
// would escalate at 10:00. Running the whole hourly job twelve times an hour
// to fix that would be the wrong end of the problem, so this is one small
// endpoint that does one thing.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  // 404, not 401 - same reasoning as the hourly route.
  if (!isAuthorizedCron(request)) return new Response('Not found', { status: 404 })

  const sweep = await sweepEmergencyEscalations()
  return Response.json({ ok: true, ...sweep })
}
