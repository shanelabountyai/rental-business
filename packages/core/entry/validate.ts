// Validation for scheduling a visit (MAINT-05, R-027).

interface Violation {
  field: string
  message: string
}

export interface ScheduleInput {
  scheduledStart?: string | null
  scheduledEnd?: string | null
  /// What the notice will say the visit is for. Required, because a notice
  /// with no stated reason is not a notice - every jurisdiction that
  /// requires one requires it to say why somebody is coming.
  reason?: string | null
  /// Present only when staff are knowingly scheduling inside the notice
  /// window. Required in that case (see validateOverride).
  overrideReason?: string | null
}

export function validateSchedule(input: ScheduleInput): Violation[] {
  const violations: Violation[] = []
  const start = input.scheduledStart?.trim()
  const end = input.scheduledEnd?.trim()

  if (!start || Number.isNaN(Date.parse(start))) {
    violations.push({ field: 'scheduledStart', message: 'Choose when the window starts.' })
  }
  if (!end || Number.isNaN(Date.parse(end))) {
    violations.push({ field: 'scheduledEnd', message: 'Choose when the window ends.' })
  }
  if (
    start &&
    end &&
    !Number.isNaN(Date.parse(start)) &&
    !Number.isNaN(Date.parse(end)) &&
    Date.parse(end) <= Date.parse(start)
  ) {
    violations.push({ field: 'scheduledEnd', message: 'The window has to end after it starts.' })
  }
  if (!input.reason?.trim()) {
    violations.push({
      field: 'reason',
      message: 'Say what the visit is for - the notice has to state a reason.',
    })
  }

  return violations
}

/// A separate check, called only when `entryDecision()` said the notice is
/// insufficient. Its own function so the requirement cannot be satisfied by
/// accident: an override reason typed into a form that did not need one is
/// harmless, but a missing one on a form that DID need it is the difference
/// between a documented judgement call and an undefended unlawful entry.
export function validateOverride(overrideReason: string | null | undefined): Violation[] {
  if (!overrideReason?.trim()) {
    return [
      {
        field: 'overrideReason',
        message:
          'This is inside the required notice period. State why you are going ahead - it is recorded.',
      },
    ]
  }
  return []
}
