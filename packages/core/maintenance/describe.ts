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

export function formatMaintenanceDescription(
  category: MaintenanceCategory,
  input: MaintenanceRequestInput,
): string {
  const lines: string[] = [`${CATEGORY_LABELS[category]} issue.`]

  for (const prompt of CLARIFYING_PROMPTS[category]) {
    const answer = input.promptAnswers[prompt.id]
    if (answer) lines.push(`${prompt.question} ${answer}`)
  }

  const steps = applicableTroubleshootingSteps(category, input.promptAnswers)
  if (steps.length > 0) {
    lines.push('')
    lines.push('Troubleshooting tried before submitting:')
    for (const step of steps) {
      const outcome = input.troubleshooting[step.id]
      if (outcome) lines.push(`- ${step.title}: ${OUTCOME_WORDS[outcome] ?? outcome}`)
    }
  }

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

/// Same shape as formatMaintenanceDescription's tail (pet/entry lines), for
/// a request staff typed up from a phone call rather than the tenant's own
/// wizard - see PhoneLoggedRequestInput's own comment for why the body is
/// free text instead of structured prompts.
export function formatPhoneLoggedDescription(
  category: MaintenanceCategory,
  input: PhoneLoggedRequestInput,
): string {
  const lines: string[] = [
    `${CATEGORY_LABELS[category]} issue, reported by phone.`,
    '',
    input.notes.trim(),
  ]

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
