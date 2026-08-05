// Validation for a tenant's maintenance request submission (MAINT-01, R-019).
// Hand-rolled, matching every other packages/core validate.ts in this repo.

import {
  type MaintenanceCategory,
  CLARIFYING_PROMPTS,
  isMaintenanceCategory,
} from './categories.ts'
import { applicableTroubleshootingSteps } from './troubleshooting.ts'

interface Violation {
  field: string
  message: string
}

export const TROUBLESHOOTING_OUTCOMES = ['TRIED', 'DECLINED'] as const
export type TroubleshootingOutcome = (typeof TROUBLESHOOTING_OUTCOMES)[number]

export interface MaintenanceRequestInput {
  category: string
  /// Keyed by ClarifyingPrompt.id.
  promptAnswers: Record<string, string>
  /// Keyed by TroubleshootingStep.id.
  troubleshooting: Record<string, string>
  /// Undefined means "not yet answered" - distinct from a false the tenant
  /// deliberately chose. See this function's own check for why that
  /// distinction is enforced rather than defaulted.
  entryPermission: boolean | undefined
  petWarning: boolean | undefined
  petNote?: string
}

/**
 * Validates a submission end to end, including the two gates MAINT-01 makes
 * explicit:
 *
 *   "logging tried-or-declined before dispatch is allowed" - every
 *   troubleshooting step that APPLIES to this category and these answers
 *   (see applicableTroubleshootingSteps) must carry a TRIED or DECLINED
 *   outcome. A step the tenant never saw (because it did not apply to their
 *   answers) is correctly not required.
 *
 *   entry permission and the pet warning are each a real yes/no answer, not
 *   a checkbox default. Both matter downstream - entry permission drives
 *   R-027's scheduling compliance check, and the pet warning is safety
 *   information a vendor relies on - so `undefined` (never answered) is
 *   refused just as firmly as a missing category, rather than silently
 *   defaulting to `false`, which is indistinguishable from a tenant who
 *   affirmatively said "no pets" / "no permission to enter".
 */
export function validateMaintenanceRequest(
  input: MaintenanceRequestInput,
): Violation[] {
  const violations: Violation[] = []

  if (!isMaintenanceCategory(input.category)) {
    violations.push({ field: 'category', message: 'Choose a category.' })
    return violations
  }
  const category = input.category as MaintenanceCategory

  for (const prompt of CLARIFYING_PROMPTS[category]) {
    const answer = input.promptAnswers[prompt.id]?.trim()
    if (!answer) {
      violations.push({
        field: `prompt.${prompt.id}`,
        message: 'Please answer this question.',
      })
      continue
    }
    if (prompt.type === 'select' && prompt.options && !prompt.options.includes(answer)) {
      violations.push({
        field: `prompt.${prompt.id}`,
        message: 'Choose one of the options shown.',
      })
    }
  }

  const steps = applicableTroubleshootingSteps(category, input.promptAnswers)
  for (const step of steps) {
    const outcome = input.troubleshooting[step.id]
    if (!outcome) {
      violations.push({
        field: `troubleshooting.${step.id}`,
        message: 'Let us know whether you tried this.',
      })
    } else if (!(TROUBLESHOOTING_OUTCOMES as readonly string[]).includes(outcome)) {
      violations.push({ field: `troubleshooting.${step.id}`, message: 'Invalid answer.' })
    }
  }

  if (input.entryPermission === undefined) {
    violations.push({
      field: 'entryPermission',
      message: 'Let us know if we can enter if you are not home.',
    })
  }
  if (input.petWarning === undefined) {
    violations.push({
      field: 'petWarning',
      message: 'Let us know if you have a pet at home.',
    })
  }

  return violations
}
