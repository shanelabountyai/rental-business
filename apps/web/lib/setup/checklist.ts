import 'server-only'

import { prisma } from '@rental/db'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { orgOwners } from '@/lib/platform/orgs.ts'

// The provisioning checklist (PRD 10 §5, R-291a, D-383). Status is DERIVED
// from facts, never a steps table: the only stored inputs are the three
// things an owner states rather than the database shows (`setupMarks`) and
// what a provider told us (`OrgIntegration.status`). Gathered in the org's own
// context - its setup page, its cron child, the go-live check - and written to
// `OrgHealth.checklist` as booleans, which is all the console reads.

export const SETUP_STEPS = [
  'owner',
  'users',
  'properties',
  'templates',
  'stripe',
  'sms',
  'email',
  'jurisdiction',
  'test',
  'live',
] as const
export type SetupStep = (typeof SETUP_STEPS)[number]
export type Checklist = Record<SetupStep, boolean>

export const SETUP_MARKS = ['just_me', 'templates_reviewed', 'shared_email'] as const
export type SetupMark = (typeof SETUP_MARKS)[number]

export const STEP_LABELS: Record<SetupStep, { label: string; owner: string }> = {
  owner: { label: 'Organisation created, owner invited and accepted', owner: 'Platform' },
  users: { label: 'Users and roles', owner: 'Organisation' },
  properties: { label: 'Entities and properties', owner: 'Organisation' },
  templates: { label: 'Message templates reviewed', owner: 'Organisation' },
  stripe: { label: 'Stripe connected', owner: 'Organisation' },
  sms: { label: 'Texting provisioned and the 10DLC campaign approved', owner: 'Platform starts, carrier finishes' },
  email: { label: 'Email domain verified', owner: 'Organisation and platform' },
  jurisdiction: { label: 'Jurisdiction confirmed', owner: 'Organisation and counsel' },
  test: { label: 'Test text and test payment', owner: 'Organisation' },
  live: { label: 'Go live', owner: 'Platform' },
}

type Integration = { status: string; statusReason: string | null }

export type SetupFacts = {
  status: 'PROVISIONING' | 'ACTIVE'
  marks: string[]
  activeOwners: number
  activeMembers: number
  entities: number
  properties: number
  templates: number
  stripe: Integration | null
  twilio: Integration | null
  resend: Integration | null
  /// Two-letter codes of active properties' states with no counsel-reviewed
  /// rule in force. Until R-298's per-org enabled states, step 8 reads the
  /// platform-published rule (D-383).
  unreviewedStates: string[]
  testText: boolean
  testPayment: boolean
}

export function setupChecklist(f: SetupFacts): Checklist {
  return {
    owner: f.activeOwners > 0,
    // Owners are members too, so a non-owner is any member beyond them.
    users: f.activeMembers > f.activeOwners || f.marks.includes('just_me'),
    properties: f.entities > 0 && f.properties > 0,
    templates: f.marks.includes('templates_reviewed'),
    stripe: f.stripe?.status === 'ENABLED',
    // `twilioRowStatus` is ACTIVE only once the campaign is APPROVED.
    sms: f.twilio?.status === 'ACTIVE',
    email: f.resend?.status === 'VERIFIED' || f.marks.includes('shared_email'),
    jurisdiction: f.properties > 0 && f.unreviewedStates.length === 0,
    test: f.testText && f.testPayment,
    live: f.status === 'ACTIVE',
  }
}

/// Every step before "Go live" is done. Read from fresh facts at the press,
/// never from a stored checklist that may be a day old.
export const readyToGoLive = (c: Checklist) => SETUP_STEPS.every((step) => step === 'live' || c[step])

/// The `OrgHealth.checklist` value: a boolean per step key and nothing else,
/// so it is safe for the console to read without a grant.
export function isChecklist(value: unknown): value is Checklist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return SETUP_STEPS.every((step) => typeof record[step] === 'boolean')
}

const provider = (state: Integration | null, name: string, done: string) => {
  if (!state || state.status === 'NOT_STARTED') return `${name} is not started.`
  if (state.status === done) return null
  // The provider's own words when it gave any (PRD 10 §5).
  const status = `${name} is ${state.status.toLowerCase().replaceAll('_', ' ')}.`
  return state.statusReason ? `${status} ${state.statusReason}` : status
}

/// Why a step is not done, in the owner's terms. Null when it is done.
export function stepReason(step: SetupStep, f: SetupFacts, c: Checklist): string | null {
  if (c[step]) return null
  switch (step) {
    case 'owner':
      return 'No owner has accepted an invitation yet.'
    case 'users':
      return 'Invite a manager or staff member, or mark that you run this alone.'
    case 'properties':
      return `${count(f.entities, 'active legal entity', 'active legal entities')} and ${count(f.properties, 'active property', 'active properties')}. Add at least one of each.`
    case 'templates':
      return `${count(f.templates, 'active message template', 'active message templates')}. Open each one you will use, then mark them reviewed.`
    case 'stripe':
      return provider(f.stripe, 'Stripe', 'ENABLED')
    case 'sms':
      return provider(f.twilio, 'Texting', 'ACTIVE')
    case 'email':
      return `${provider(f.resend, 'Your email domain', 'VERIFIED')} Or send from the shared domain under your organisation's name.`
    case 'jurisdiction':
      return f.properties === 0
        ? 'No properties yet.'
        : `No counsel-reviewed rule is in force for ${f.unreviewedStates.join(', ')}. The platform publishes these.`
    case 'test':
      return [
        f.testText ? null : "No text has been delivered to an owner's own phone yet.",
        f.testPayment ? null : 'No payment has been received and recorded yet.',
      ]
        .filter(Boolean)
        .join(' ')
    case 'live':
      return 'The platform marks the organisation live once every step above is done.'
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/// The facts, gathered inside one org. Counts and statuses only.
export async function setupFacts(orgId: string, now = new Date()): Promise<SetupFacts> {
  const owners = await orgOwners(orgId)
  const [org, activeMembers, entities, properties, templates, integrations, testText, testPayment, rentPayment, places] =
    await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { status: true, setupMarks: true } }),
      prisma.orgMembership.count({ where: { orgId, removedAt: null, staffUser: { active: true } } }),
      prisma.legalEntity.count({ where: { orgId, active: true } }),
      prisma.property.count({ where: { orgId, active: true } }),
      prisma.messageTemplate.count({ where: { orgId, active: true } }),
      prisma.orgIntegration.findMany({
        where: { orgId, provider: { in: ['STRIPE', 'TWILIO', 'RESEND'] } },
        select: { provider: true, status: true, statusReason: true },
      }),
      prisma.notificationDelivery.count({
        where: {
          orgId,
          status: { in: ['DELIVERED', 'READ'] },
          notification: { channel: 'SMS', recipientType: 'STAFF', recipientId: { in: owners.map((o) => o.id) } },
        },
      }),
      // The owner's paid $1 (R-291b, D-384), or any rent already received.
      prisma.setupTestPayment.count({ where: { orgId } }),
      prisma.ledgerEntry.count({ where: { orgId, type: 'PAYMENT' } }),
      prisma.property.findMany({
        where: { orgId, active: true },
        select: { state: true, county: true },
        distinct: ['state', 'county'],
      }),
    ])
  const unreviewed = new Set<string>()
  for (const place of places) {
    const rule = await rulesForConfigured(place, now)
    // Only a two-letter code leaves the org (the OrgHealth posture).
    if (!rule?.reviewedBy) unreviewed.add(/^[A-Z]{2}$/.test(place.state) ? place.state : '??')
  }
  const row = (p: string) => integrations.find((i) => i.provider === p) ?? null
  return {
    status: org.status,
    marks: org.setupMarks,
    activeOwners: owners.length,
    activeMembers,
    entities,
    properties,
    templates,
    stripe: row('STRIPE'),
    twilio: row('TWILIO'),
    resend: row('RESEND'),
    unreviewedStates: [...unreviewed].sort(),
    testText: testText > 0,
    testPayment: testPayment + rentPayment > 0,
  }
}
