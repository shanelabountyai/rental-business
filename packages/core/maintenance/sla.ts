// First-response SLA and its visual escalation (MAINT-02, R-023).
//
// "Given a new ticket, when the first-response SLA (config, e.g. 4 business
// hours) nears breach, then the ticket escalates visually and notifies the
// owner." Two deliberate simplifications, both worth naming rather than
// quietly building around:
//
// ponytail: wall-clock hours, not business hours. A real "4 business hours"
// clock (skip nights and weekends, per property timezone) needs calendar
// machinery nothing in packages/core/scheduling provides yet, and inventing
// it for one threshold check here would be solving a harder problem than
// this item asks. A ticket filed Friday evening reads as "breaching" over
// the weekend under this measure when a business-hours clock would not have
// started counting yet - overwarning, never underwarning, which is the
// direction to be wrong in for a habitability-adjacent clock. Upgrade path:
// a shared "elapsed business hours since X, in this property's timezone"
// helper in packages/core/scheduling, the moment a second caller needs one.
//
// ponytail: the "notifies the owner" half is NOT built here. R-023 depends
// on R-019 and R-011 only, deliberately not R-016 (notifications) - there is
// no periodic sweep in this product yet that could decide "this crossed the
// line since I last checked" and call notify(). The visual escalation below
// is real and lives on both the Task and the ticket list; a proactive push
// is future work for whichever item adds a periodic SLA sweep (a natural
// fit for R-029's after-hours routing, which already owns escalation).

export const FIRST_RESPONSE_SLA_HOURS = 4

/// The point at which the visual treatment shifts from "on track" to
/// "approaching" before the deadline is actually missed - three quarters of
/// the way through the window, the same "warn before it's too late" shape
/// R-011's own overdue treatment does not need (a task is either overdue or
/// it isn't; a countable SLA window can and should warn ahead of the line).
const WARNING_FRACTION = 0.75

export type SlaState = 'on_track' | 'approaching' | 'breached' | 'responded'

/**
 * Where a ticket sits against its first-response clock, given the current
 * time. Tickets already responded to (a non-null firstResponseAt) are
 * "responded" regardless of when that happened - the clock's whole job is
 * done the moment a human engages, whether that took ten minutes or four
 * hours.
 */
export function firstResponseSlaState(
  ticket: { createdAt: Date; firstResponseAt: Date | null },
  now: Date,
): SlaState {
  if (ticket.firstResponseAt) return 'responded'

  const elapsedHours = (now.getTime() - ticket.createdAt.getTime()) / 3_600_000
  if (elapsedHours >= FIRST_RESPONSE_SLA_HOURS) return 'breached'
  if (elapsedHours >= FIRST_RESPONSE_SLA_HOURS * WARNING_FRACTION) return 'approaching'
  return 'on_track'
}

/// R-050's dashboard glow threshold: "emergency/urgent tickets open >48h". A
/// DIFFERENT CLOCK from the first-response SLA above, not a second reading
/// of the same one - that clock measures "did anybody engage yet" and stops
/// the moment they do, while this measures "how long has this been sitting
/// open at all", which keeps ticking through triage, dispatch and the wait
/// for a vendor. A ticket answered within four hours and still open eleven
/// days later is on_track by one measure and glowing by this one, and both
/// readings are correct at once.
export const OPEN_TICKET_GLOW_HOURS = 48

/// Priorities the glow applies to. ROUTINE work sitting open for two days is
/// normal; the dashboard's whole "exception-first" premise is that only the
/// two priorities where two days is itself the exception get flagged.
const GLOWS_WHEN_OPEN: readonly string[] = ['EMERGENCY', 'URGENT']

/**
 * Whether an open ticket should glow red on the dashboard (RPT-01).
 *
 * Wall-clock hours, the same simplification this file's own header already
 * names and justifies for the first-response clock above - a real
 * business-hours measure needs calendar machinery this package does not
 * have yet, and the direction this is wrong in (a Friday-evening emergency
 * reads as older than a business-hours clock would say over the weekend) is
 * the safe direction for something exception-first.
 */
export function ticketGlows(
  ticket: { priority: string; createdAt: Date },
  now: Date,
): boolean {
  if (!GLOWS_WHEN_OPEN.includes(ticket.priority)) return false
  const elapsedHours = (now.getTime() - ticket.createdAt.getTime()) / 3_600_000
  return elapsedHours >= OPEN_TICKET_GLOW_HOURS
}
