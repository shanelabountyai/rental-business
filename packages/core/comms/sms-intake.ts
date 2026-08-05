// Whether an inbound text should open a maintenance ticket (R-021).
//
// The backlog's own framing: "a text to the business number creates a ticket
// and threads into it. Roughly half of real requests arrive this way; a
// portal-only intake measures adoption it created rather than demand that
// exists."
//
// THE RULE IS NOT "EVERY TEXT IS A TICKET." A tenant mid-conversation types
// "thanks", "ok see you then", "the plumber never showed" - three messages,
// one problem. Opening a ticket per text would bury the real queue under
// conversational noise within a week, and the staff response is always the
// same: merge them, or ignore the queue. R-023 has a merge-duplicates tool
// precisely because duplicates happen; that is not a reason to manufacture
// them here.
//
// So: the FIRST text from a tenant with nothing open becomes a ticket, and
// everything after it threads into the conversation until that ticket is
// resolved. Both halves are deliberate, and the second is the one that makes
// this usable.

/// Ticket statuses that mean "somebody is already dealing with this", so a
/// further text is part of the same conversation rather than a new problem.
/// Mirrors the TicketStatus enum; MERGED and CLOSED are absent because a
/// tenant texting after either really is raising something new. Exported as
/// an array too - R-022's staff queue list filters `status: { in: [...] }`
/// with this same list, and a second copy is exactly how the two would
/// eventually disagree about what "open" means.
export const OPEN_TICKET_STATUSES = [
  'NEW',
  'TRIAGED',
  'WAITING_ON_TENANT',
  'CONVERTED',
] as const

const OPEN_TICKET_STATUS_SET: ReadonlySet<string> = new Set(OPEN_TICKET_STATUSES)

export function isOpenTicketStatus(status: string): boolean {
  return OPEN_TICKET_STATUS_SET.has(status)
}

export type SmsIntakeDecision =
  | { outcome: 'open_ticket' }
  | { outcome: 'thread_only'; existingTicketId: string }

/**
 * Given the tenant's currently-open tickets, decide whether this text opens
 * a new one.
 *
 * Pure, and takes the tickets rather than fetching them, so the rule can be
 * argued about and tested without a database - the same shape every other
 * decision function in this codebase takes.
 *
 * `openTickets` should be newest-first; the most recent open ticket is the
 * one a further text is most likely about.
 */
export function decideSmsIntake(
  openTickets: readonly { id: string; status: string }[],
): SmsIntakeDecision {
  const open = openTickets.find((ticket) => isOpenTicketStatus(ticket.status))
  return open
    ? { outcome: 'thread_only', existingTicketId: open.id }
    : { outcome: 'open_ticket' }
}

/**
 * The description a ticket opened from a text carries.
 *
 * The tenant's own words, verbatim and first, with the channel noted after -
 * whoever triages it needs to read what was actually sent, and needs to know
 * they cannot ask a follow-up question through a portal the sender may never
 * have opened.
 *
 * Deliberately does NOT try to categorise. R-019's structured intake gets a
 * category because it ASKED; a text has not been asked anything, and guessing
 * a category from keywords would put a wrong label on the one intake path
 * with no clarifying prompts to correct it. R-023's triage assigns the real
 * category, from a human reading this.
 */
export function formatSmsTicketDescription(body: string): string {
  return [
    body.trim(),
    '',
    'Sent by text message. The tenant has not answered any clarifying questions, and may not use the portal — reply by text.',
  ].join('\n')
}
