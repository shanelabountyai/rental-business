// The tenant maintenance request taxonomy (MAINT-01, R-019).
//
// Seven categories, matching MAINT-01's own list exactly: "plumbing /
// electrical / HVAC / appliance / pest / exterior / locks". Deliberately NOT
// including the emergency categories (active flooding, gas smell, CO alarm,
// and so on) - those get their own safety-first path, skip troubleshooting
// entirely, and page on-call regardless of hour, all of which is R-020's job
// and depends on R-016 (notifications), which this item does not. Adding
// them here without R-020's branching would either half-build the emergency
// behavior or silently run a tenant reporting a gas smell through a
// "reset your GFCI" script, which is the wrong kind of wrong.
//
// D-10's tenant lexicon governs every label here: plain words, no internal
// vocabulary a tenant would not use themselves.

export const MAINTENANCE_CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'HVAC',
  'APPLIANCE',
  'PEST',
  'EXTERIOR',
  'LOCKS',
] as const

export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number]

const CATEGORY_SET: ReadonlySet<string> = new Set(MAINTENANCE_CATEGORIES)

export function isMaintenanceCategory(
  value: string,
): value is MaintenanceCategory {
  return CATEGORY_SET.has(value)
}

export const CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  PLUMBING: 'Plumbing',
  ELECTRICAL: 'Electrical',
  HVAC: 'Heating & cooling',
  APPLIANCE: 'Appliance',
  PEST: 'Pests or bugs',
  EXTERIOR: 'Outside the home',
  LOCKS: 'Locks & doors',
}

/// One structured clarifying question (MAINT-01: "structured clarifying
/// prompts, 2-3 per category"). `select` is the default shape - a tenant
/// picking from a short list is faster and more consistent than typing, which
/// is what "under 2 minutes" and a usable troubleshooting/triage pipeline
/// both need. `text` is used only where the real answers are too varied to
/// enumerate (which appliance is broken, in their own words).
export interface ClarifyingPrompt {
  id: string
  question: string
  type: 'select' | 'text'
  options?: readonly string[]
}

export const CLARIFYING_PROMPTS: Record<
  MaintenanceCategory,
  readonly ClarifyingPrompt[]
> = {
  PLUMBING: [
    {
      id: 'where',
      question: 'Where is the problem?',
      type: 'select',
      options: ['Kitchen sink', 'Bathroom sink', 'Toilet', 'Shower or tub', 'Other'],
    },
    {
      id: 'leaking_now',
      question: 'Is water actively leaking right now?',
      type: 'select',
      options: ['Yes', 'No'],
    },
    {
      id: 'only_toilet',
      question: 'If this is a toilet: is it your only one, and not working?',
      type: 'select',
      options: ['Yes', 'No', 'Not about a toilet'],
    },
  ],
  ELECTRICAL: [
    {
      id: 'what',
      question: "What isn't working?",
      type: 'select',
      options: ['One outlet', 'One light fixture', 'Multiple outlets or lights', 'Whole room or home'],
    },
    {
      id: 'extent',
      question: 'Is it just one room, or the whole home?',
      type: 'select',
      options: ['One room', 'Whole home'],
    },
  ],
  HVAC: [
    {
      id: 'system',
      question: 'Is this about heating, cooling, or the thermostat?',
      type: 'select',
      options: ['Heating', 'Cooling', 'Thermostat'],
    },
    {
      id: 'symptom',
      question: "What's happening?",
      type: 'select',
      options: ["Won't turn on", "Won't reach the set temperature", 'Making a loud noise', 'Other'],
    },
  ],
  APPLIANCE: [
    {
      id: 'appliance',
      question: 'Which appliance?',
      type: 'select',
      options: [
        'Refrigerator',
        'Range or oven',
        'Dishwasher',
        'Washer',
        'Dryer',
        'Garbage disposal',
        'Other',
      ],
    },
    {
      id: 'symptom',
      question: "What's happening? A sentence or two is fine.",
      type: 'text',
    },
  ],
  PEST: [
    {
      id: 'seen',
      question: 'What have you seen?',
      type: 'select',
      options: ['Ants', 'Roaches', 'Mice or rats', 'Other insects', 'Other'],
    },
    {
      id: 'where',
      question: 'Where have you seen them?',
      type: 'text',
    },
  ],
  EXTERIOR: [
    {
      id: 'what',
      question: "What's the issue?",
      type: 'select',
      options: ['Roof or gutter', 'Fence', 'Driveway or walkway', 'Yard or sprinklers', 'Other'],
    },
    {
      id: 'where',
      question: 'Where exactly?',
      type: 'text',
    },
  ],
  LOCKS: [
    {
      id: 'what',
      question: "What's the problem?",
      type: 'select',
      options: ["Won't lock", "Won't unlock", 'Broken handle', 'Lost or broken key', 'Other'],
    },
    {
      id: 'which_door',
      question: 'Which door?',
      type: 'select',
      options: ['Front door', 'Back door', 'Garage', 'Other'],
    },
  ],
}
