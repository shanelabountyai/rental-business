import { checkToken, hashToken } from '@rental/core/auth'
import { icalendarFeed } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { loadStaffActor } from '@/lib/auth/actor.ts'
import { calendarEventsFor, feedWindow } from '@/lib/calendar/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

// A staff member's own visit calendar (NOTIF-06, R-097c).
//
// ==========================================================================
// PUBLIC BY DESIGN, like every other token-scoped route here: no session, no
// account, the token in the path is the entire credential. What is different
// is that this one is fetched by a MACHINE - a calendar app polling on its
// own schedule, with nobody watching - so three things follow.
//
//   * IT ANSWERS 404 FOR EVERY BAD TOKEN, never a message. There is nobody
//     to read an explanation, and a distinguishable "expired" reply would
//     tell somebody probing that a token existed.
//   * IT RESOLVES THE SCOPE FRESH ON EVERY FETCH rather than freezing it
//     into the token. A staff member moved to one property, or deactivated,
//     stops seeing the rest on their calendar's next poll - which is what
//     ROLE-06's "access dies within a minute" means for a surface that
//     nobody logs out of.
//   * `mfaVerified: false`, always. A link sitting in a calendar app is not
//     a proved second factor, and saying otherwise here would quietly hand
//     every privileged check a way in that never sees a login.
//
// AN EMPTY CALENDAR IS STILL A CALENDAR: a feed that 404s when nothing is
// scheduled is one the subscribing app quietly drops, and the staff member
// discovers it by missing a visit.
// ==========================================================================

export const dynamic = 'force-dynamic'

function notFound() {
  return new Response('Not found', { status: 404 })
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const stored = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } })
  const verdict = checkToken(stored, { purpose: 'CALENDAR_FEED', subjectType: 'StaffUser' })
  if (!verdict.ok) return notFound()

  const actor = await loadStaffActor(stored!.subjectId, false)
  // A deactivated staff member's calendar stops updating, and stops the
  // moment their account does - the whole reason the scope is not baked into
  // the token.
  if (!actor || !actor.active) return notFound()

  const scope = await currentScope(actor)
  const now = new Date()
  const events = await calendarEventsFor(scope.propertyIds, feedWindow(now))

  const body = icalendarFeed({
    name: 'Visits — Rental Operations',
    events,
    generatedAt: now,
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      // Named so a downloaded copy is recognisable; `inline` because the
      // usual caller is a subscription, not a download.
      'content-disposition': 'inline; filename="visits.ics"',
      // Per-person data behind a bearer token in a URL. Nothing in front of
      // this should keep a copy.
      'cache-control': 'no-store, private',
    },
  })
}
