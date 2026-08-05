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

/// Every registered template, by key. Later items add theirs here.
export const TEMPLATES: Readonly<Record<string, NotificationTemplate<never>>> = {
  [unitMakeReadyTemplate.key]:
    unitMakeReadyTemplate as unknown as NotificationTemplate<never>,
  [maintenanceEmergencyTemplate.key]:
    maintenanceEmergencyTemplate as unknown as NotificationTemplate<never>,
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
