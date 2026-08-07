// Templates (NOTIF-01's "template" step).
//
// A template is a pure function from context to rendered text, per channel.
// Not a string with `{{placeholders}}`: a typed function is checked at compile
// time, so a template referencing a field the caller does not pass is a build
// error rather than a rent reminder that says "Hi undefined".
//
// The registry starts nearly empty ON PURPOSE, exactly as R-006's
// SCHEDULED_JOBS and CONSUMERS do. R-016 builds the engine; the items that own
// each message write their own template - R-045 for the payment ladder, R-020
// for emergency intake, R-027 for entry notices, R-062 for legal notices. What
// ships here is the mechanism plus the one template the engine's own consumer
// needs, so the path is proved end to end rather than asserted.
//
// D-10 governs the WORDS in any tenant- or vendor-facing template: home or
// unit (not "door"), maintenance request (not "ticket" or "work order"), and
// no internal identifier - no backlog id, no status enum, no entity name - may
// appear in one. `renderTemplate` cannot enforce that; review does.

import type { NotificationCategory, NotificationChannel } from './categories.ts'

export interface RenderedMessage {
  /// Ignored by SMS, which has no subject line. Present for EMAIL and PORTAL.
  subject?: string
  body: string
}

/**
 * SMS bodies are kept short deliberately. A segment is 160 GSM-7 characters
 * and a message that spills into three of them costs three times as much and
 * arrives out of order often enough to matter on some carriers - so the SMS
 * variant of a template is a summary with a link, never the email text.
 */
export interface NotificationTemplate<Context> {
  key: string
  category: NotificationCategory
  /// Which channels this template can render. A template with no SMS variant
  /// simply is not sent by SMS, however the recipient's preferences read.
  channels: readonly NotificationChannel[]
  render: (context: Context, channel: NotificationChannel) => RenderedMessage
}

/// Context for `unit.make_ready`. The only template R-016 itself ships - see
/// this file's header.
export interface UnitMakeReadyContext {
  propertyName: string
  unitName: string
}

/**
 * A lease ended with no renewal in place, so R-009's nightly job flipped the
 * unit to MAKE_READY and emitted `unit.became_make_ready`. Staff-facing, so
 * D-10's tenant lexicon does not apply and "unit" is the operator's own word.
 */
export const unitMakeReadyTemplate: NotificationTemplate<UnitMakeReadyContext> =
  {
    key: 'unit.make_ready',
    category: 'unit_make_ready',
    channels: ['EMAIL', 'PORTAL'],
    render: (context, channel) => {
      const headline = `${context.unitName} at ${context.propertyName} is ready to turn`
      if (channel === 'SMS') return { body: headline }
      return {
        subject: headline,
        body: [
          headline + '.',
          '',
          'The lease ended without a renewal, so the unit moved to make-ready automatically. Scheduling the turn now is what keeps the vacancy short.',
        ].join('\n'),
      }
    },
  }

/// Context for `maintenance.emergency` (R-020).
export interface MaintenanceEmergencyContext {
  /// The emergency in the tenant's own words, from EMERGENCY_DEFINITIONS -
  /// "I smell gas", not "GAS_SMELL". Whoever is woken up should read what
  /// the tenant actually reported, not an enum.
  emergencyLabel: string
  propertyName: string
  addressLine1: string
  unitName: string
  tenantName: string
  tenantPhone: string | null
  petWarning: boolean
  entryPermission: boolean
}

/**
 * A tenant reported an emergency (MAINT-01, R-020). Staff-facing, and the
 * one template in this build whose whole job is to wake somebody up.
 *
 * Written to be ACTED ON FROM A LOCK SCREEN AT 2AM. The SMS variant leads
 * with the word EMERGENCY, then the thing, then the address, then the
 * tenant's phone number - in that order, because somebody half-awake reads
 * the first line and needs to know whether to get out of bed, and the very
 * next thing they will do is call the tenant. A pet warning rides along
 * because whoever arrives may be opening a door in the dark.
 *
 * Deliberately does NOT include a link as the primary content: a link is
 * useless to somebody who has to drive, and the phone number is the thing
 * that actually starts the response.
 */
export const maintenanceEmergencyTemplate: NotificationTemplate<MaintenanceEmergencyContext> =
  {
    key: 'maintenance.emergency',
    category: 'maintenance_emergency',
    channels: ['SMS', 'EMAIL', 'PORTAL'],
    render: (context, channel) => {
      const where = `${context.addressLine1}${
        context.unitName ? ` (${context.unitName})` : ''
      }`
      const contact = context.tenantPhone
        ? `${context.tenantName} ${context.tenantPhone}`
        : `${context.tenantName} (no phone on file)`

      if (channel === 'SMS') {
        return {
          body: [
            `EMERGENCY: ${context.emergencyLabel}`,
            where,
            contact,
            context.petWarning ? 'Pet on site.' : null,
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }

      return {
        subject: `EMERGENCY: ${context.emergencyLabel} — ${where}`,
        body: [
          `${context.tenantName} reported an emergency at ${where}.`,
          '',
          `What they reported: ${context.emergencyLabel}`,
          `Reach them on: ${context.tenantPhone ?? 'no phone on file'}`,
          `Property: ${context.propertyName}`,
          '',
          context.petWarning
            ? 'There is a pet at home.'
            : 'No pet reported at home.',
          context.entryPermission
            ? 'Entry permitted if the tenant is not home.'
            : 'Entry NOT permitted unless the tenant is home.',
          '',
          'Safety instructions were shown to the tenant before they submitted this.',
        ].join('\n'),
      }
    },
  }

/// Context for `workorder.vendor_dispatch` (R-025).
export interface VendorDispatchContext {
  vendorName: string
  scope: string
  addressLine1: string
  unitName: string
  priority: string
  /// The magic link itself. THE ENTIRE POINT of this message - a vendor with
  /// no account has nothing else to act on (D-6).
  link: string
}

/**
 * The dispatch message a vendor actually receives (MAINT-03, D-6, R-025).
 *
 * Inverts the usual SMS rule stated at the top of this file. Every other
 * template treats SMS as "a summary, with a link" because the detail belongs
 * in the email. Here the LINK IS THE MESSAGE: a vendor has no account, no
 * inbox we control, and nothing to log into - the whole job (scope, address,
 * photos, tenant phone, access codes, upload) lives behind that one URL. So
 * the SMS leads with what and where in one line each, then the link, and
 * says nothing that would push the link into a second segment.
 *
 * No PORTAL channel: a vendor has no portal, by design.
 */
export const vendorDispatchTemplate: NotificationTemplate<VendorDispatchContext> =
  {
    key: 'workorder.vendor_dispatch',
    category: 'work_order_assigned',
    channels: ['SMS', 'EMAIL'],
    render: (context, channel) => {
      const where = `${context.addressLine1} (${context.unitName})`

      if (channel === 'SMS') {
        return {
          body: [
            context.priority === 'EMERGENCY' ? 'EMERGENCY JOB' : 'New job',
            `${context.scope.slice(0, 80)}`,
            where,
            context.link,
          ].join('\n'),
        }
      }

      return {
        subject: `New job: ${context.scope.slice(0, 60)} — ${where}`,
        body: [
          `${context.vendorName},`,
          '',
          `We would like to send you to ${where}.`,
          '',
          `What is needed: ${context.scope}`,
          `Priority: ${context.priority}`,
          '',
          'Everything for this job - photos, the tenant\u2019s phone number, access details, and where to upload your invoice - is here:',
          context.link,
          '',
          'You do not need an account. The link works until you tell us either way, and expires after three days.',
        ].join('\n'),
      }
    },
  }

/// Context for `workorder.bid_request` (R-026).
export interface VendorBidRequestContext {
  vendorName: string
  scope: string
  addressLine1: string
  unitName: string
  link: string
}

/// A request for a PRICE, not a dispatch (MAINT-04). Says so plainly in the
/// first line, because a vendor who reads "new job" and turns up to a job
/// that was never awarded to them has been wasted, and will remember.
export const vendorBidRequestTemplate: NotificationTemplate<VendorBidRequestContext> =
  {
    key: 'workorder.bid_request',
    category: 'work_order_assigned',
    channels: ['SMS', 'EMAIL'],
    render: (context, channel) => {
      const where = `${context.addressLine1} (${context.unitName})`
      if (channel === 'SMS') {
        return {
          body: [`Quote request (not yet awarded)`, context.scope.slice(0, 70), where, context.link].join('\n'),
        }
      }
      return {
        subject: `Quote request: ${context.scope.slice(0, 60)} — ${where}`,
        body: [
          `${context.vendorName},`,
          '',
          `We are collecting prices for a job at ${where} and would like yours.`,
          '',
          `What is needed: ${context.scope}`,
          '',
          'This is a request for a quote - the job has not been awarded yet.',
          context.link,
          '',
          'You do not need an account. The link expires after three days.',
        ].join('\n'),
      }
    },
  }

/// Context for `entry.notice` (R-027). Times arrive as ISO strings and are
/// rendered in the PROPERTY's timezone - a tenant told 2pm when somebody
/// arrives at 9am is worse off than one told nothing (D-3).
export interface EntryNoticeContext {
  tenantName: string
  addressLine1: string
  unitName: string
  scheduledStart: string
  scheduledEnd: string
  timezone: string
  reason: string
  /// Set on the T-1-day reminder rather than the original notice, so the
  /// two read differently even though they carry the same facts.
  isReminder?: boolean
}

/**
 * Entry notice, and its T-1-day reminder (MAINT-05, COMM-02).
 *
 * `entry_notice` is a LOCKED category (packages/core/notifications/
 * categories.ts): a tenant cannot turn this off, because it is the
 * legally significant message telling them somebody is coming into their
 * home. That is the whole reason LOCKED_CATEGORIES exists.
 */
export const entryNoticeTemplate: NotificationTemplate<EntryNoticeContext> = {
  key: 'entry.notice',
  category: 'entry_notice',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    const window = formatEntryWindow(
      new Date(context.scheduledStart),
      new Date(context.scheduledEnd),
      context.timezone,
    )
    const lead = context.isReminder ? 'Reminder' : 'Notice of entry'

    if (channel === 'SMS') {
      return {
        body: [
          `${lead}: we plan to enter your home`,
          window,
          context.reason,
        ].join('\n'),
      }
    }

    return {
      subject: `${lead}: entry at ${context.addressLine1} — ${window}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        context.isReminder
          ? 'This is a reminder about a visit we told you about:'
          : 'We are writing to let you know we plan to enter your home:',
        '',
        window,
        `Reason: ${context.reason}`,
        '',
        'If this time does not work, reply to this message and we will arrange another.',
      ].join('\n'),
    }
  },
}

function formatEntryWindow(start: Date, end: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(start)
  const time = (value: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(value)
  return `${date}, between ${time(start)} and ${time(end)}`
}

/// Every registered template, by key. Later items add theirs here.
/// Context for `maintenance.emergency_escalation` (NOTIF-05, R-029).
export interface EmergencyEscalationContext extends MaintenanceEmergencyContext {
  /// How long the emergency has sat unacknowledged. Stated, not implied - a
  /// recipient needs to know whether this is 15 minutes old or two hours.
  minutesUnacknowledged: number
  /// True when nobody was on call and the first page already went to
  /// everybody, so this is a second, louder page to the same people rather
  /// than a genuine escalation past somebody.
  repage: boolean
}

/**
 * Nobody acknowledged an emergency page (NOTIF-05: "emergency ticket
 * unacknowledged 15 min -> escalate past on-call to owner", R-029).
 *
 * Same category as the first page, deliberately - `maintenance_emergency` is
 * what bypasses quiet hours and cannot be unsubscribed from, and an
 * escalation that could be silenced or deferred until 8am would be an
 * escalation in name only.
 *
 * Leads with UNACKNOWLEDGED rather than repeating EMERGENCY, so somebody who
 * has already seen the first page can tell at a glance that this is the
 * chain firing rather than a second incident.
 */
export const emergencyEscalationTemplate: NotificationTemplate<EmergencyEscalationContext> =
  {
    key: 'maintenance.emergency_escalation',
    category: 'maintenance_emergency',
    channels: ['SMS', 'EMAIL', 'PORTAL'],
    render: (context, channel) => {
      const where = `${context.addressLine1}${
        context.unitName ? ` (${context.unitName})` : ''
      }`
      const headline = `UNACKNOWLEDGED ${context.minutesUnacknowledged}m: ${context.emergencyLabel}`

      if (channel === 'SMS') {
        return {
          body: [
            headline,
            where,
            context.tenantPhone
              ? `${context.tenantName} ${context.tenantPhone}`
              : `${context.tenantName} (no phone on file)`,
            context.repage ? null : 'Nobody on call has responded.',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }

      return {
        subject: `${headline} — ${where}`,
        body: [
          `An emergency at ${where} has gone ${context.minutesUnacknowledged} minutes without anybody acknowledging it.`,
          '',
          `What the tenant reported: ${context.emergencyLabel}`,
          `Reach them on: ${context.tenantPhone ?? 'no phone on file'}`,
          '',
          context.repage
            ? 'Nobody was on call when this came in, so everybody with authority over the property was paged and is being paged again now.'
            : 'The on-call staff were paged and have not acknowledged, so this has escalated to you.',
          '',
          'Open the ticket and acknowledge it so the chain stops.',
        ].join('\n'),
      }
    },
  }

export const TEMPLATES: Readonly<Record<string, NotificationTemplate<never>>> = {
  [unitMakeReadyTemplate.key]:
    unitMakeReadyTemplate as unknown as NotificationTemplate<never>,
  [maintenanceEmergencyTemplate.key]:
    maintenanceEmergencyTemplate as unknown as NotificationTemplate<never>,
  [vendorDispatchTemplate.key]:
    vendorDispatchTemplate as unknown as NotificationTemplate<never>,
  [vendorBidRequestTemplate.key]:
    vendorBidRequestTemplate as unknown as NotificationTemplate<never>,
  [entryNoticeTemplate.key]:
    entryNoticeTemplate as unknown as NotificationTemplate<never>,
  [emergencyEscalationTemplate.key]:
    emergencyEscalationTemplate as unknown as NotificationTemplate<never>,
}

export class UnknownTemplateError extends Error {
  readonly templateKey: string

  constructor(templateKey: string) {
    super(
      `No notification template registered under "${templateKey}". Templates live in packages/core/notifications/templates.ts; a send referencing an unregistered key is a wiring bug, not a runtime condition to swallow.`,
    )
    this.name = 'UnknownTemplateError'
    this.templateKey = templateKey
  }
}

/**
 * Renders a registered template.
 *
 * Throws on an unknown key rather than returning null. A notification that
 * silently does not render is a notification the product promised and did not
 * send, and the caller is always code - never user input - so the only way to
 * reach this is a mistake worth failing loudly on.
 */
export function renderTemplate(
  templateKey: string,
  context: unknown,
  channel: NotificationChannel,
): RenderedMessage {
  const template = TEMPLATES[templateKey]
  if (!template) throw new UnknownTemplateError(templateKey)
  return template.render(context as never, channel)
}

export function templateFor(
  templateKey: string,
): NotificationTemplate<never> | undefined {
  return TEMPLATES[templateKey]
}
