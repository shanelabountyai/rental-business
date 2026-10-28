import { sweepEmergencyEscalations } from '@/lib/maintenance/escalation.ts'
import { cronRoute } from '@/lib/cron/per-org.ts'

// The escalation tick (NOTIF-05, R-029). Every fifteen minutes in
// production since D-263 - a five-minute tick kept the demo's Neon database
// from ever suspending. A deployment serving real tenants wants `*/5` back.
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

// Per org (R-290), with no claim: each tick's sweep is idempotent per ticket
// on its own, and a claim per fifteen minutes would be a row per org per tick.
export function GET(request: Request) {
  return cronRoute(request, 'escalations', async (orgId) => ({
    ok: true,
    ...(await sweepEmergencyEscalations(new Date(), { orgId })),
  }))
}
