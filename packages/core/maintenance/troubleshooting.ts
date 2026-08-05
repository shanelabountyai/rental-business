// Category-specific troubleshooting scripts (MAINT-01: "a troubleshooting
// script with pictures runs first ... logging tried/declined before dispatch
// is allowed"), R-019.
//
// The exact list the backlog names: tripped breaker, GFCI reset (noting the
// controlling GFCI may be in another room), disposal reset button/Allen key,
// thermostat battery, furnace switch, flapper, pilot light. Every one of
// those seven appears below, each attached to the category (and sometimes
// the specific clarifying answer) it actually applies to.
//
// `appliesWhen` is checked against the tenant's own clarifying-prompt
// answers, so a script only shows when it could plausibly help - the
// disposal-reset script for someone who said "Range or oven", or the pilot
// light for someone who said "Cooling", would be noise, not help. The same
// function drives what the wizard SHOWS and what validate.ts REQUIRES an
// answer for, so the two can never drift apart - the risk this pattern
// avoids is a hidden step the UI doesn't render but the validator still
// silently demands, or the reverse (a required step someone can skip on the
// UI but the log is missing).

import type { MaintenanceCategory } from './categories.ts'

export interface TroubleshootingStep {
  id: string
  title: string
  instructions: string
  /// Whether this step applies, given the category's own clarifying-prompt
  /// answers. Absent means "always applies to this category".
  appliesWhen?: (answers: Record<string, string>) => boolean
}

export const TROUBLESHOOTING_SCRIPTS: Partial<
  Record<MaintenanceCategory, readonly TroubleshootingStep[]>
> = {
  ELECTRICAL: [
    {
      id: 'breaker',
      title: 'Check the breaker panel',
      instructions:
        "Find your breaker panel and look for a switch that's flipped to the middle, or fully off. If you find one, flip it all the way off, then firmly back on.",
    },
    {
      id: 'gfci',
      title: 'Check for a GFCI reset button',
      instructions:
        "Look for a \"test / reset\" button on nearby outlets, especially in kitchens, bathrooms, garages, or outdoors. The GFCI controlling this outlet may be in another room - check other outlets too. Press \"reset\" firmly.",
    },
  ],
  APPLIANCE: [
    {
      id: 'disposal_reset',
      title: 'Try resetting the disposal',
      instructions:
        "Look under the sink for a small red button on the bottom of the disposal - press it firmly. If that doesn't work, look for a hex-key hole in the center of the drain and turn it firmly back and forth with an Allen wrench.",
      appliesWhen: (answers) => answers.appliance === 'Garbage disposal',
    },
  ],
  HVAC: [
    {
      id: 'thermostat_battery',
      title: 'Check the thermostat battery',
      instructions:
        'Many thermostats run on batteries. If the display looks dim, blank, or is not responding, try replacing them.',
    },
    {
      id: 'furnace_switch',
      title: 'Check the furnace power switch',
      instructions:
        "Furnaces have a power switch nearby that looks just like an ordinary wall light switch. Make sure it hasn't been accidentally turned off.",
      appliesWhen: (answers) =>
        answers.system === 'Heating' || answers.system === 'Thermostat',
    },
    {
      id: 'pilot_light',
      title: 'Check the pilot light',
      instructions:
        'If you have a gas furnace, look for a small viewing window and check whether the pilot light is lit.',
      appliesWhen: (answers) => answers.system === 'Heating',
    },
  ],
  PLUMBING: [
    {
      id: 'flapper',
      title: 'Check the toilet flapper',
      instructions:
        "Take the lid off the toilet tank and check that the rubber flapper at the bottom is sealing properly. Jiggle the handle and see if that stops the water from running.",
      appliesWhen: (answers) => answers.where === 'Toilet',
    },
  ],
}

/// Every step that applies to this category given these answers - what the
/// wizard renders, and what validateMaintenanceRequest requires a tried/
/// declined answer for. See this module's own header for why one function
/// serves both.
export function applicableTroubleshootingSteps(
  category: MaintenanceCategory,
  answers: Record<string, string>,
): readonly TroubleshootingStep[] {
  const steps = TROUBLESHOOTING_SCRIPTS[category]
  if (!steps) return []
  return steps.filter((step) => !step.appliesWhen || step.appliesWhen(answers))
}
