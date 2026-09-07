// Turns a structured submission into the one readable paragraph that becomes
// `Ticket.description` (R-019).
//
// The tenant never free-types a paragraph - MAINT-01 asks for structured
// prompts precisely so the whole thing takes under two minutes on a phone.
// This is what makes that trade-off work for whoever reads the ticket next:
// a plain-language transcript of exactly what was asked and answered, in the
// order it was asked, so a tech opening the ticket sees the same thing the
// tenant saw rather than a bag of field:value pairs.

import { CLARIFYING_PROMPTS, CATEGORY_LABELS, type MaintenanceCategory } from './categories.ts'
import { applicableTroubleshootingSteps } from './troubleshooting.ts'
import type { MaintenanceRequestInput, PhoneLoggedRequestInput } from './validate.ts'

const OUTCOME_WORDS: Record<string, string> = {
  TRIED: 'Tried this - did not fix it.',
  DECLINED: 'Did not try this.',
}

/**
 * The question-and-answer transcript, shared by every intake path that runs
 * the script (R-177): the tenant's own wizard, the clarify link a texted-in
 * request is answered through, and the phone-logged form a PM reads aloud.
 *
 * One function so the three cannot drift into three different-looking
 * tickets for the same facts - whoever triages reads all three.
 */
function transcriptLines(
  category: MaintenanceCategory,
  input: MaintenanceRequestInput,
): string[] {
  const lines: string[] = []

  for (const prompt of CLARIFYING_PROMPTS[category]) {
    const answer = input.promptAnswers[prompt.id]
    if (answer) lines.push(`${prompt.question} ${answer}`)
  }

  const steps = applicableTroubleshootingSteps(category, input.promptAnswers)
  if (steps.length > 0) {
    lines.push('')
    lines.push('Troubleshooting tried before dispatch:')
    for (const step of steps) {
      const outcome = input.troubleshooting[step.id]
      if (outcome) lines.push(`- ${step.title}: ${OUTCOME_WORDS[outcome] ?? outcome}`)
    }
  }

  return lines
}

export function formatMaintenanceDescription(
  category: MaintenanceCategory,
  input: MaintenanceRequestInput,
): string {
  const lines: string[] = [`${CATEGORY_LABELS[category]} issue.`]
  lines.push(...transcriptLines(category, input))

  if (input.petWarning) {
    lines.push('')
    lines.push(
      input.petNote?.trim()
        ? `There is a pet at home: ${input.petNote.trim()}`
        : 'There is a pet at home.',
    )
  }

  lines.push('')
  lines.push(
    input.entryPermission
      ? 'Entry permitted if the tenant is not home.'
      : 'Entry NOT permitted unless the tenant is home.',
  )

  return lines.join('\n')
}

/// A request staff typed up from a phone call. The caller's own words FIRST -
/// a call has things in it no prompt asks for - then the same transcript the
/// tenant's own wizard produces, because since R-177 the PM runs the same
/// script on screen while the tenant is still on the line.
export function formatPhoneLoggedDescription(
  category: MaintenanceCategory,
  input: PhoneLoggedRequestInput,
): string {
  const lines: string[] = [
    `${CATEGORY_LABELS[category]} issue, reported by phone.`,
    '',
    input.notes.trim(),
    '',
  ]
  lines.push(...transcriptLines(category, input))

  if (input.petWarning) {
    lines.push('')
    lines.push(
      input.petNote?.trim()
        ? `There is a pet at home: ${input.petNote.trim()}`
        : 'There is a pet at home.',
    )
  }

  lines.push('')
  lines.push(
    input.entryPermission
      ? 'Entry permitted if the tenant is not home.'
      : 'Entry NOT permitted unless the tenant is home.',
  )

  return lines.join('\n')
}

/**
 * The clarification a texted-in request gets, APPENDED to what is already
 * there (R-177).
 *
 * Appended, never replaced, and that is the whole design of this function.
 * An SMS ticket's description is the tenant's OWN WORDS, verbatim, off the
 * message they sent - `formatSmsTicketDescription` leads with them
 * deliberately. Overwriting that with a tidy structured transcript would
 * destroy the one piece of evidence nobody can reconstruct, on the intake
 * path whose whole premise is that the tenant does not use the portal.
 *
 * The separator says WHEN, in the record's own terms, because the two halves
 * were written at different moments by the same person and a triager reading
 * them as one paragraph would misread the second as part of the text.
 */
export function appendClarification(
  existing: string,
  category: MaintenanceCategory,
  input: MaintenanceRequestInput,
): string {
  return [
    existing.trimEnd(),
    '',
    'The tenant answered our questions after sending this:',
    '',
    formatMaintenanceDescription(category, input),
  ].join('\n')
}

/**
 * The reporter's OWN WORDS, back out of a description we assembled (R-177).
 *
 * Every intake formatter in the product puts them first and separates them
 * from the staff-facing tail with a blank line — `formatSmsTicketDescription`
 * (packages/core/comms), `formatPhoneLoggedDescription` above, and
 * `formatMaintenanceDescription`, whose first line is the category sentence
 * the tenant effectively chose. This makes that shared shape a CONTRACT with
 * a test on it rather than a coincidence three files happen to share.
 *
 * Why it has to exist at all: the clarify page shows a tenant what we think
 * they told us, and the rest of an SMS ticket's description is written AT
 * STAFF — "may not use the portal — reply by text" is internal operating
 * vocabulary that D-10 keeps out of anything tenant-facing. Echoing the whole
 * field would put it in front of the one person it is not for.
 */
export function reportedWords(description: string): string {
  return description.split('\n\n')[0]!.trim()
}
