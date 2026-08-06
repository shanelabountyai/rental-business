// Merging duplicate tickets during triage (MAINT-02, R-023).
//
// "Merge duplicates" is the same shape as R-021's own comment about not
// letting a conversation fragment into five tickets: two texts and a phone
// call about the same leak are one problem, and a PM reading them side by
// side is the one who can tell.

interface Violation {
  field: string
  message: string
}

/// Statuses a triage decision has already been made for - the Task behind
/// each is already DONE (setTicketPriority/resolveTicketTriage/
/// mergeTicketDuplicate's own completeTaskWork call), so none of triage's
/// actions make sense against them any more. The ONE place this line is
/// drawn: the app layer's page (whether to render the resolved summary or
/// the action forms) and its actions (whether to refuse a stale or replayed
/// request) both call this rather than each drawing it themselves.
const RESOLVED_TICKET_STATUSES: ReadonlySet<string> = new Set([
  'WAITING_ON_TENANT',
  'CONVERTED',
  'MERGED',
  'CLOSED',
])

export function isTicketTriageResolved(status: string): boolean {
  return RESOLVED_TICKET_STATUSES.has(status)
}

/// Statuses a ticket can still be the LIVE half of a merge - i.e. still a
/// real, ongoing ticket. WAITING_ON_TENANT and CONVERTED are valid targets
/// (a duplicate discovered after the original already moved past initial
/// triage is still the same problem); MERGED and CLOSED are not - merging
/// into something already resolved would silently reopen nothing and just
/// hide the source ticket.
const MERGEABLE_TARGET_STATUSES: ReadonlySet<string> = new Set([
  'NEW',
  'TRIAGED',
  'WAITING_ON_TENANT',
  'CONVERTED',
])

export function canMergeTicket(
  source: { id: string; propertyId: string; status: string },
  target: { id: string; propertyId: string; status: string },
): Violation[] {
  const violations: Violation[] = []

  if (source.id === target.id) {
    violations.push({ field: 'targetTicketId', message: 'A ticket cannot be merged into itself.' })
    return violations
  }
  if (source.propertyId !== target.propertyId) {
    violations.push({
      field: 'targetTicketId',
      message: 'Duplicates can only be merged within the same property.',
    })
  }
  if (isTicketTriageResolved(source.status)) {
    violations.push({ field: 'targetTicketId', message: 'This ticket is already resolved.' })
  }
  if (!MERGEABLE_TARGET_STATUSES.has(target.status)) {
    violations.push({
      field: 'targetTicketId',
      message: 'Choose a ticket that is still open.',
    })
  }

  return violations
}
