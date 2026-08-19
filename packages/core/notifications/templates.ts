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

import { formatCents } from '../money/money.ts'
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

/// Context for `workorder.verify_request` (MAINT-07, R-030).
export interface VerifyRequestContext {
  tenantName: string
  /// What the tenant asked for, in their words - not the internal scope.
  requestSummary: string
  addressLine1: string
  /// Deep link to the tenant's own request, where the two buttons are.
  url: string
}

/**
 * "Was this resolved?" (MAINT-07, R-030).
 *
 * ONE QUESTION, TWO BUTTONS BEHIND ONE LINK. The whole value of this message
 * is the reply rate: a tenant who does not answer leaves the PM closing jobs
 * on faith, and every extra sentence between them and the tap costs answers.
 * So it names the job, asks the question, and stops.
 *
 * `maintenance_update`, not a locked category - a tenant who does not want
 * to be asked to rate work is entitled to turn this off, and one who has
 * turned it off is telling the PM something worth knowing.
 */
export const verifyRequestTemplate: NotificationTemplate<VerifyRequestContext> = {
  key: 'workorder.verify_request',
  category: 'maintenance_update',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `The work at ${context.addressLine1} is done: ${context.requestSummary}`,
          'Is it actually fixed? Tell us here:',
          context.url,
        ].join('\n'),
      }
    }

    return {
      subject: `Is it fixed? — ${context.requestSummary}`,
      body: [
        `Hi ${context.tenantName},`,
        '',
        `Someone has finished the work you reported at ${context.addressLine1}:`,
        '',
        context.requestSummary,
        '',
        'Before we close it off, we want to hear from you rather than assume. One tap:',
        '',
        context.url,
        '',
        'If it is not fixed, saying so reopens it — you do not need to report it again.',
      ].join('\n'),
    }
  },
}

/// Context for `payment.receipt` (PAY-01, R-037).
export interface PaymentReceiptContext {
  tenantName: string
  /// What actually arrived, formatted. The rent and the card fee are shown
  /// SEPARATELY where a fee applied - a receipt that reports only the total
  /// is a receipt somebody rings up about.
  amount: string
  feeAmount: string | null
  total: string
  addressLine1: string
  /// What is left owing after this payment, formatted. "$0.00" is the
  /// sentence tenants actually want, so it is said in words rather than
  /// left to be inferred from its absence.
  remaining: string
  paidOn: string
}

/**
 * "We got your rent" (PAY-01, R-037).
 *
 * SENT ON SETTLEMENT, NEVER ON SUBMISSION. An ACH debit sits in flight for
 * three to five days and can still be returned; a receipt at submission is a
 * receipt for money that may never arrive, and it is the document a tenant
 * will later hold up to prove they paid. The ledger and this message move at
 * the same moment for the same reason.
 *
 * `payment_receipt` is not a locked category - a tenant who does not want a
 * text every month is entitled to turn it off - but email carries it
 * regardless, because a receipt is the kind of record people go looking for
 * months later.
 */
export const paymentReceiptTemplate: NotificationTemplate<PaymentReceiptContext> = {
  key: 'payment.receipt',
  category: 'payment_receipt',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `We received ${context.total} for ${context.addressLine1} on ${context.paidOn}.`,
          `Balance now: ${context.remaining}.`,
        ].join(' '),
      }
    }
    return {
      subject: `Payment received — ${context.total}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        `We received your payment for ${context.addressLine1} on ${context.paidOn}.`,
        '',
        context.feeAmount
          ? `Payment: ${context.amount}\nCard processing fee: ${context.feeAmount}\nTotal charged: ${context.total}`
          : `Amount: ${context.total}`,
        '',
        `Balance remaining: ${context.remaining}`,
        '',
        'Keep this email — it is your receipt.',
      ].join('\n'),
    }
  },
}

/// Context for `payment.returned` (PAY-02, R-039).
export interface PaymentReturnedContext {
  tenantName: string
  amount: string
  addressLine1: string
  /// What is owed again now the credit has come back off.
  balance: string
  /// Absent where the state bars the fee or the lease is silent - the
  /// template says nothing about a fee rather than saying "$0.00".
  ///
  /// NOT included in `balance`. The fee is pushed to Stripe as an invoice
  /// item and reaches the ledger only when the next invoice finalizes (D-11),
  /// so at the moment this message is written the tenant owes `balance` and
  /// will owe the fee on top. Saying both, separately, is the honest reading
  /// of the two numbers.
  feeAmount: string | null
}

/**
 * "Your payment came back" (PAY-02, R-039).
 *
 * SAYS WHAT HAPPENED AND WHAT TO DO, in that order, and does not speculate
 * about why. A bank returns a debit for reasons the tenant may find
 * embarrassing and we do not actually know - Stripe reports a failure code,
 * not a life situation - so this states the fact, restores the number, and
 * asks them to sort it out.
 *
 * `payment_failed` is a LOCKED category on SMS (see categories.ts): a tenant
 * cannot turn this one off, because believing rent is paid when it is not is
 * how somebody ends up in eviction proceedings over a bank error.
 */
export const paymentReturnedTemplate: NotificationTemplate<PaymentReturnedContext> = {
  key: 'payment.returned',
  category: 'payment_failed',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `Your ${context.amount} payment for ${context.addressLine1} was returned by the bank.`,
          `You now owe ${context.balance}.`,
          // The fee belongs on SMS too, not only in the email (R-039a). This
          // is the LOCKED channel - the one a tenant cannot switch off and
          // therefore the one they actually see - and learning about a
          // charge from a later invoice, having been texted about the same
          // event, is how a tenant decides the landlord is hiding things.
          context.feeAmount ? `A returned-payment fee of ${context.feeAmount} applies.` : '',
          'Please get in touch so we can sort it out.',
        ]
          .filter((part) => part !== '')
          .join(' '),
      }
    }
    return {
      subject: 'Your payment was returned',
      body: [
        `Hello ${context.tenantName},`,
        '',
        `Your payment of ${context.amount} for ${context.addressLine1} was returned by your bank, so it has been taken back off your balance.`,
        '',
        `You now owe ${context.balance}.`,
        context.feeAmount ? `A returned-payment fee of ${context.feeAmount} also applies.` : '',
        '',
        'If you think this is a mistake, or you need to arrange something, please contact the office — we would much rather hear from you than not.',
      ]
        .filter((line, index, all) => line !== '' || all[index - 1] !== '')
        .join('\n'),
    }
  },
}

export interface AutopayPredebitContext {
  tenantName: string
  addressLine1: string
  /// The recurring amount the subscription bills - what we told Stripe to
  /// collect, not a guess at the final invoice.
  amount: string
  /// Property-local calendar date the debit is expected.
  debitOn: string
}

/**
 * "We are about to take rent" (PAY-02, R-039a).
 *
 * TWO DAYS AHEAD, WHICH IS THE WHOLE POINT. Autopay moves money out of
 * somebody's bank account without them doing anything, and the difference
 * between a working system and an angry phone call is whether they saw it
 * coming. Two days is enough to move money in, or to ring the office before
 * an overdraft rather than after one.
 *
 * SAYS THE RECURRING AMOUNT, NOT A PREDICTED TOTAL. What we know is what the
 * subscription bills - `stripeAmountCents`, the instruction we gave Stripe.
 * The final invoice can carry a late fee or a part-month charge added since,
 * and quoting a precise total we cannot guarantee would be worse than
 * quoting none: a pre-debit notice whose number is wrong teaches a tenant to
 * ignore the next one.
 *
 * NOT a locked category. `autopay_predebit` sits under Money rather than
 * under the legally significant set, deliberately - a tenant who has read a
 * hundred of these may reasonably want fewer, and unlike an entry notice
 * nothing about it is a statutory service. Turning it off does not stop the
 * debit; it stops the warning, which is their call to make.
 */
export const autopayPredebitTemplate: NotificationTemplate<AutopayPredebitContext> = {
  key: 'autopay.predebit',
  category: 'autopay_predebit',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `Heads up: we will collect ${context.amount} rent for ${context.addressLine1} on ${context.debitOn}.`,
          'Nothing to do if that works for you.',
        ].join(' '),
      }
    }
    return {
      subject: `Rent of ${context.amount} will be collected on ${context.debitOn}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        `This is a heads up that we will collect ${context.amount} for ${context.addressLine1} on ${context.debitOn}, using the payment method you saved.`,
        '',
        // Honest about what it does not know. See the note above.
        'If anything else is outstanding it may be collected at the same time, and the receipt will show the exact amount.',
        '',
        'Nothing to do if that works for you. If it does not, please contact the office before that date rather than letting it fail.',
      ].join('\n'),
    }
  },
}

/// Context for `vendor.declined` (R-032a).
export interface VendorDeclinedContext {
  vendorName: string
  /// The job in the scope's own words, so somebody deciding who to send next
  /// does not have to open the work order to know what it is.
  scope: string
  unitName: string
  propertyName: string
  priority: string
  /// What they said, when they said anything. Often the most useful part -
  /// "no van until Tuesday" and "not my trade" lead to different next calls.
  declineReason: string | null
}

/**
 * A vendor said no (MAINT-03, R-032a).
 *
 * THE ONE THAT MATTERS MOST IN THIS ITEM. A vendor who never answers is
 * caught by the no-response sweep; a vendor who declines answered, so the
 * sweep's `vendorRespondedAt: null` filter steps over them entirely. Before
 * this, a decline produced an audit row and nothing else - the job quietly
 * returned to the unassigned queue and an urgent leak sat there overnight.
 * A decline is worse than silence, so it is the one that reaches a person.
 */
const vendorDeclinedTemplate: NotificationTemplate<VendorDeclinedContext> = {
  key: 'vendor.declined',
  category: 'vendor_response',
  // SMS included, unlike the other staff-facing templates. This is the case
  // where somebody has to pick up a phone and call the next vendor, and an
  // email at 6pm on a burst pipe is a notification that arrives too late to
  // be one.
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    const headline = `${context.vendorName} declined ${context.unitName} — ${context.scope}`
    if (channel === 'SMS') {
      return {
        body:
          `${headline}${context.declineReason ? ` ("${context.declineReason}")` : ''}. ` +
          `${context.priority} — it is back in the queue and needs another vendor.`,
      }
    }
    return {
      subject: `Declined: ${context.scope} (${context.unitName})`,
      body: [
        `${context.vendorName} has declined this job.`,
        '',
        `Property: ${context.propertyName}`,
        `Unit: ${context.unitName}`,
        `Job: ${context.scope}`,
        `Priority: ${context.priority}`,
        context.declineReason
          ? `They said: "${context.declineReason}"`
          : 'They gave no reason.',
        '',
        // Says what already happened, so nobody re-does it. The decline
        // clears the vendor and returns the job to the queue.
        'The job is back in the unassigned queue and the vendor has been cleared, so the trade’s fallback list will not offer them again. A task has been raised to re-dispatch it.',
      ].join('\n'),
    }
  },
}

/// Context for `vendor.message` (R-032a, COMM-06).
export interface VendorMessageContext {
  vendorName: string
  scope: string
  unitName: string
  /// Trimmed at the call site, because a vendor pasting three paragraphs into
  /// an SMS should not send three paragraphs back out.
  preview: string
}

/**
 * A vendor said something (COMM-06, R-032a).
 *
 * R-032 built the vendor's only free-text channel and left it unread: the
 * message landed in the work order's thread and nothing told anybody it was
 * there. A channel nobody reads is worse than no channel, because the vendor
 * believes they have told us.
 */
const vendorMessageTemplate: NotificationTemplate<VendorMessageContext> = {
  key: 'vendor.message',
  category: 'vendor_response',
  // No SMS. A vendor asking a question is not an emergency, and the whole
  // point of a separate category is that this one can be read when somebody
  // sits down. The decline above is the one that interrupts.
  channels: ['EMAIL', 'PORTAL'],
  render: (context, channel) => {
    const headline = `${context.vendorName} sent a message about ${context.unitName}`
    if (channel === 'SMS') return { body: `${headline}: ${context.preview}` }
    return {
      subject: headline,
      body: [
        `${context.vendorName} wrote about ${context.scope} (${context.unitName}):`,
        '',
        context.preview,
        '',
        'It is on the work order’s timeline, and a task has been raised to answer it.',
      ].join('\n'),
    }
  },
}

/// Context for `workorder.chargeback_posted` (MAINT-07, R-031). Amounts are
/// pre-formatted strings, not cents: the template renders, core computes, and
/// a message that did its own money maths would be a second place for the
/// number to be wrong.
export interface ChargebackPostedContext {
  tenantName: string
  addressLine1: string
  jobSummary: string
  /// Formatted. What is being added to their account.
  amount: string
  /// Formatted. What the repair actually cost — present only when the tenant
  /// is being billed less than that, because saying "the repair cost $412 and
  /// you owe $412" twice is noise.
  jobCost?: string
  /// Deep link to the tenant's own payment history, where the charge and its
  /// evidence are.
  url: string
}

/**
 * "You have been charged for a repair" (MAINT-07, R-031).
 *
 * ==========================================================================
 * `legal_notice`, WHICH IS LOCKED — a tenant cannot turn this off.
 *
 * Deliberately not `maintenance_update`. A tenant who has switched off
 * updates about work orders is saying they do not need to know a plumber is
 * coming; they are not waiving notice that money is being taken from them.
 * A charge that appears on an account with no message preceding it is how a
 * routine chargeback becomes a dispute, and on a locked category it cannot
 * happen through a preference nobody remembered setting.
 *
 * IT LEADS WITH THE NUMBER, then the reason, then where to look. A tenant
 * reading this on a phone lock screen should learn the amount from the first
 * line — burying it under an explanation reads as an attempt to soften it,
 * and the served Notice carries the full reasoning anyway.
 * ==========================================================================
 */
export const chargebackPostedTemplate: NotificationTemplate<ChargebackPostedContext> = {
  key: 'workorder.chargeback_posted',
  category: 'legal_notice',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `A repair charge of ${context.amount} has been added to your account at ${context.addressLine1}.`,
          context.jobSummary,
          `Details, the reason, and the invoice: ${context.url}`,
        ].join('\n'),
      }
    }

    return {
      subject: `Repair charge of ${context.amount} — ${context.addressLine1}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        `A charge of ${context.amount} has been added to your account for this repair:`,
        '',
        context.jobSummary,
        '',
        context.jobCost
          ? `The repair cost ${context.jobCost}. You are being charged ${context.amount} of that — not the full cost.`
          : 'This was recorded as tenant-caused rather than normal wear.',
        '',
        'The full notice explains why, and the contractor invoice and any photos are attached to the repair:',
        '',
        context.url,
        '',
        'If you disagree with this charge, tell us before it becomes due and we will review it with you.',
      ].join('\n'),
    }
  },
}

/// Context for `comms.managed_template` (COMM-03, R-044). Already rendered -
/// see the template below.
export interface ManagedTemplateContext {
  subject: string | null
  body: string
}

/**
 * The carrier for a MANAGED template (R-044).
 *
 * ==========================================================================
 * IT RENDERS NOTHING, AND THAT IS THE POINT.
 *
 * Managed templates are database rows a property manager wrote, with their
 * own merge-field catalogue, their own validation and their own translation
 * rules (D-44). All of that runs in `renderForRecipient` BEFORE the engine is
 * called, because it needs a database and this file is pure.
 *
 * So this template exists purely to give the notification engine - which
 * requires a registered `templateKey` and refuses an unknown one - something
 * to dispatch. Re-rendering here would be a second implementation of merge
 * fields living where nothing can test it against real data.
 *
 * The SMS branch drops the subject rather than prefixing it: a subject line
 * is an email concept, and repeating it as the first line of a text is how a
 * 160-character segment becomes three.
 * ==========================================================================
 */
export const managedTemplate: NotificationTemplate<ManagedTemplateContext> = {
  key: 'comms.managed_template',
  category: 'rent_reminder',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) =>
    channel === 'SMS'
      ? { body: context.body }
      : { subject: context.subject ?? undefined, body: context.body },
}

/**
 * The same carrier, registered under `announcement` (COMM-04, R-053).
 *
 * `notify()` refuses when a template's fixed category disagrees with the
 * call's category, so `managedTemplate` above - locked to `rent_reminder` -
 * cannot also carry a segment announcement. A second registration, not a
 * parameter: the render function has no category-specific behavior, only the
 * key and category differ.
 */
export const announcementTemplate: NotificationTemplate<ManagedTemplateContext> = {
  key: 'comms.announcement',
  category: 'announcement',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: managedTemplate.render,
}

/// Context for `payment.due_soon` and `payment.due` (PAY-02, R-045). One
/// template, two lead times - the wording differs by a handful of words and
/// having two functions drift apart is a worse failure mode than one
/// function branching on a boolean.
export interface DueContext {
  tenantName: string
  addressLine1: string
  amount: string
  /// Property-local calendar date (D-3).
  dueOn: string
  /// True on the due date itself; false three days out.
  isDueToday: boolean
  /// A pay-now link (R-046), when one could be minted. Null when the payer
  /// has no Stripe customer yet — the message still goes, because "rent is
  /// due" is worth saying on its own, and a link that lands on a broken
  /// payment screen is worse than none.
  url?: string | null
}

/**
 * "Rent is due soon" / "rent is due today" (PAY-02, R-045).
 *
 * ==========================================================================
 * NOT FOR AN AUTOPAY TENANT. This is the reminder for somebody who has to
 * DO something - go to the portal, mail a check - and a tenant on
 * `charge_automatically` already gets `autopay.predebit`, which says the
 * money is being taken care of. Sending both would tell an autopay tenant to
 * pay rent they are about to have collected automatically, which reads as
 * the product not knowing its own state. The caller is responsible for this
 * split; see `sendDueNotices`.
 *
 * `rent_reminder`, not locked. A tenant who has never once been late is
 * entitled to turn this off, the same call `autopay.predebit` makes for the
 * same reason.
 * ==========================================================================
 */
export const rentDueTemplate: NotificationTemplate<DueContext> = {
  key: 'payment.due_soon',
  category: 'rent_reminder',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    const lead = context.isDueToday
      ? `Rent of ${context.amount} for ${context.addressLine1} is due today.`
      : `Rent of ${context.amount} for ${context.addressLine1} is due ${context.dueOn}.`

    if (channel === 'SMS') {
      // THE LINK IS THE WHOLE POINT OF THE SMS (R-046). A text saying "rent
      // is due" with no way to act on it sends somebody hunting for an email
      // login they may not have — which is the dead end R-046 exists to
      // remove.
      return { body: context.url ? `${lead} Pay here: ${context.url}` : lead }
    }
    return {
      subject: context.isDueToday
        ? `Rent is due today — ${context.amount}`
        : `Rent is due ${context.dueOn} — ${context.amount}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        lead,
        '',
        ...(context.url
          ? ['You can pay straight from here — no sign-in needed:', '', context.url]
          : ['You can pay from your portal any time before then.']),
      ].join('\n'),
    }
  },
}

/// Context for `payment.failed_fix` (PAY-02, R-045).
export interface PaymentFailedContext {
  tenantName: string
  addressLine1: string
  amount: string
  /// Stripe's own decline reason where one exists - "insufficient_funds",
  /// "expired_card" - rendered in plain words rather than passed through
  /// verbatim, because a tenant has never seen a Stripe error code before.
  reason: string | null
  /// Deep link to fix the payment method, so the message is an action rather
  /// than only bad news.
  url: string
}

/**
 * "Your payment failed — here is how to fix it" (PAY-02, R-045).
 *
 * ==========================================================================
 * DIFFERENT FROM `payment.returned`, DELIBERATELY. That template covers a
 * payment that succeeded and then bounced back days later - a bank returning
 * an ACH debit. This covers a charge attempt that never went through in the
 * first place - a declined card, an expired one - and the tenant has not
 * been told their balance changed because it never did. What they need is
 * not "your balance is back" but "try again, here is the button."
 *
 * `payment_failed`, the same LOCKED category `payment.returned` uses:
 * believing rent went through when it did not is how somebody ends up in
 * eviction proceedings over a card that expired quietly.
 * ==========================================================================
 */
export const paymentFailedFixTemplate: NotificationTemplate<PaymentFailedContext> = {
  key: 'payment.failed_fix',
  category: 'payment_failed',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `Your ${context.amount} rent payment for ${context.addressLine1} did not go through${
            context.reason ? ` (${context.reason})` : ''
          }.`,
          `Fix it here: ${context.url}`,
        ].join(' '),
      }
    }
    return {
      subject: 'Your rent payment did not go through',
      body: [
        `Hello ${context.tenantName},`,
        '',
        `Your payment of ${context.amount} for ${context.addressLine1} did not go through${
          context.reason ? ` — ${context.reason}` : ''
        }.`,
        '',
        'Update your payment method or try again here:',
        '',
        context.url,
        '',
        'If this was not you, or you need help, please contact the office.',
      ].join('\n'),
    }
  },
}

/// Context for `payment.card_expiring` (PAY-02, R-045).
export interface CardExpiringContext {
  tenantName: string
  addressLine1: string
  /// "12/2026" - month/year only, never a full card number. This is the one
  /// piece of card metadata this product ever surfaces, read live from the
  /// provider and never stored.
  expiresOn: string
  url: string
}

/**
 * "Your card on file is expiring — update it before rent is due" (PAY-02,
 * R-045).
 *
 * ==========================================================================
 * THE WHOLE REASON FOR THIS TEMPLATE: A LONG-TENURED, ALWAYS-ON-TIME TENANT
 * SHOULD NEVER SEE `payment.failed_fix`.
 *
 * Without a warning, a card silently expiring is indistinguishable from a
 * tenant who stopped paying - the autopay charge fails, the returned-payment
 * flow fires, and somebody who has paid on time for three years gets the
 * same dunning message as somebody who has not. This is the message that
 * keeps that person out of that ladder, sent while there is still a month to
 * act rather than after the first failed charge.
 *
 * NOT locked. Unlike `payment_failed` - which reports something that already
 * went wrong and a tenant should never be able to silence - this warns about
 * something that has not happened yet, and a tenant who reads their bank
 * statement and knows their card is fine is entitled to turn the warning off.
 * ==========================================================================
 */
export const cardExpiringTemplate: NotificationTemplate<CardExpiringContext> = {
  key: 'payment.card_expiring',
  category: 'rent_reminder',
  channels: ['SMS', 'EMAIL', 'PORTAL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `The card on file for ${context.addressLine1} expires ${context.expiresOn}.`,
          `Update it before your next rent is due: ${context.url}`,
        ].join(' '),
      }
    }
    return {
      subject: `Your card on file expires ${context.expiresOn}`,
      body: [
        `Hello ${context.tenantName},`,
        '',
        `The card we have on file for ${context.addressLine1} expires ${context.expiresOn}.`,
        '',
        "If it is still valid there is nothing to do, but if it has been replaced, please update it before rent is next due so your payment does not fail:",
        '',
        context.url,
      ].join('\n'),
    }
  },
}

/// Context for `notifications.digest_daily` (NOTIF-04, R-054). Each item is
/// an already-rendered notification that was batched instead of sent on its
/// own - see `send.ts`'s `digest_batched` branch - so this template lists
/// what each one already said rather than re-deriving it.
export interface DigestContext {
  items: readonly { subject: string | null; body: string }[]
}

/**
 * The daily digest itself (NOTIF-04: "notification fatigue kills adoption").
 *
 * EMAIL only (see `channelsFor` in categories.ts) - a digest is exactly the
 * long-form, read-when-convenient shape SMS is wrong for, and there is
 * nothing to batch into a portal notice that isn't already sitting in the
 * portal.
 */
export const digestTemplate: NotificationTemplate<DigestContext> = {
  key: 'notifications.digest_daily',
  category: 'digest_daily',
  channels: ['EMAIL'],
  render: (context) => {
    const count = context.items.length
    const subject = `Daily digest — ${count} update${count === 1 ? '' : 's'}`
    const body = context.items
      .map((item, index) => `${index + 1}. ${item.subject ?? item.body.split('\n')[0]}`)
      .join('\n\n')
    return {
      subject,
      body: [
        `Batched from today's non-urgent notifications, sent once instead of ${count === 1 ? 'on its own' : 'one at a time'}:`,
        '',
        body,
      ].join('\n'),
    }
  },
}

/// Context for `prospect.prescreen_invite` (LEASE-07, R-058).
export interface ProspectPrescreenContext {
  firstName: string
  addressLine1: string
  /// The five-question pre-screen link (a single-use PROSPECT_PRESCREEN
  /// token).
  url: string
}

/**
 * The identical pre-screening invite (LEASE-07: "auto-sent... identical for
 * all inquirers").
 *
 * A CODE TEMPLATE, DELIBERATELY NOT A MANAGED ONE. R-049's managed-template
 * carrier (`comms.managed_template`/`comms.announcement`) exists so a PM can
 * author and edit wording per property - which is exactly the axis this
 * message must NOT vary on. Fair housing requires every inquirer see the
 * identical five questions in the identical words; a PM-editable template
 * would let two prospects on two properties be asked differently, which is
 * the one thing this item exists to prevent. `renderForRecipient()`
 * (apps/web/lib/comms/templates.ts) is also built around a TENANT audience
 * (`{ tenantId, leaseId }`) a prospect does not have - a second reason this
 * is the simpler, more correct choice, not merely the lazier one.
 */
export const prospectPrescreenTemplate: NotificationTemplate<ProspectPrescreenContext> = {
  key: 'prospect.prescreen_invite',
  category: 'prospect_prescreening',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `Thanks for your interest in ${context.addressLine1}. A few quick questions before we go further:`,
          context.url,
        ].join('\n'),
      }
    }
    return {
      subject: `A few questions about ${context.addressLine1}`,
      body: [
        `Hi ${context.firstName},`,
        '',
        `Thanks for asking about ${context.addressLine1}. Before we go further, we ask everyone who inquires the same five questions - move date, occupants, pets, income range, and prior evictions:`,
        '',
        context.url,
        '',
        "It takes about a minute, and it's how we keep this fair to everyone who inquires.",
      ].join('\n'),
    }
  },
}

/// Context for `application.invite` (LEASE-03, R-059) - the lead
/// applicant, invited by staff off their own Prospect record.
export interface ApplicationInviteContext {
  firstName: string
  addressLine1: string
  /// The applicant's own APPLICATION_LINK (multi-use until it expires).
  url: string
}

export const applicationInviteTemplate: NotificationTemplate<ApplicationInviteContext> = {
  key: 'application.invite',
  category: 'prospect_application',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [`Ready to apply for ${context.addressLine1}? Start here:`, context.url].join('\n'),
      }
    }
    return {
      subject: `Apply for ${context.addressLine1}`,
      body: [
        `Hi ${context.firstName},`,
        '',
        `You're invited to apply for ${context.addressLine1}. The link below is yours - come back to it anytime to finish, your progress is saved as you go:`,
        '',
        context.url,
      ].join('\n'),
    }
  },
}

/// Context for `lease.sign_invite` (LEASE-06, R-063) - one signer's own
/// review-and-sign link.
export interface LeaseSignInviteContext {
  name: string
  addressLine1: string
  /// The signer's own LEASE_SIGN link (multi-use until it expires).
  url: string
}

/**
 * "Your lease is ready to sign" (LEASE-06, R-063).
 *
 * ONE LINK PER SIGNER, not a shared one - each recipient's `url` is scoped
 * to their own `LeaseSigner.id` (see the schema's own comment on
 * `AuthTokenPurpose.LEASE_SIGN`), so a co-tenant or guarantor sent this
 * message can only sign their own line.
 */
export const leaseSignInviteTemplate: NotificationTemplate<LeaseSignInviteContext> = {
  key: 'lease.sign_invite',
  category: 'lease_signature',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [`Your lease for ${context.addressLine1} is ready to sign:`, context.url].join('\n'),
      }
    }
    return {
      subject: `Sign your lease — ${context.addressLine1}`,
      body: [
        `Hi ${context.name},`,
        '',
        `Your lease for ${context.addressLine1} is ready for your signature. Review it and sign here:`,
        '',
        context.url,
      ].join('\n'),
    }
  },
}

/// Context for `application.coapplicant_invite` (LEASE-03, R-059) - anyone
/// the lead applicant adds to the household after being invited.
export interface CoApplicantInviteContext {
  firstName: string
  /// Whoever added them - "Jordan Blake invited you to apply alongside
  /// them", not a bare link with no explanation of why it arrived.
  leadName: string
  addressLine1: string
  url: string
}

export const coApplicantInviteTemplate: NotificationTemplate<CoApplicantInviteContext> = {
  key: 'application.coapplicant_invite',
  category: 'prospect_application',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [
          `${context.leadName} added you to their application for ${context.addressLine1}. Your own link:`,
          context.url,
        ].join('\n'),
      }
    }
    return {
      subject: `${context.leadName} added you to an application`,
      body: [
        `Hi ${context.firstName},`,
        '',
        `${context.leadName} listed you as a co-applicant for ${context.addressLine1}. Fill in your own section here - it takes a few minutes, and your progress is saved as you go:`,
        '',
        context.url,
      ].join('\n'),
    }
  },
}

/// Context for `application.fee_paid` (LEASE-03, R-059) - one applicant's
/// own confirmation, sent once their fee clears (never before - D-11's
/// webhook-confirmed rule, same as every other payment confirmation here).
export interface ApplicationFeePaidContext {
  firstName: string
  addressLine1: string
  amountCents: number
}

export const applicationFeePaidTemplate: NotificationTemplate<ApplicationFeePaidContext> = {
  key: 'application.fee_paid',
  category: 'prospect_application',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    const amount = formatCents(context.amountCents)
    if (channel === 'SMS') {
      return {
        body: `Got it - your ${amount} application fee for ${context.addressLine1} is paid. Thanks!`,
      }
    }
    return {
      subject: `Application fee received - ${context.addressLine1}`,
      body: [
        `Hi ${context.firstName},`,
        '',
        `We received your ${amount} application fee for ${context.addressLine1}. Thanks for applying.`,
      ].join('\n'),
    }
  },
}

/// Context for `application.adverse_action` (LEASE-05, R-061) - the FCRA
/// notice, sent by EMAIL the moment a DECLINED or APPROVED_WITH_CONDITIONS
/// decision is recorded (never SMS - CRA name/address/phone and a rights
/// disclosure do not fit a text message, and channelsFor('prospect_application')
/// already restricts this category to EMAIL/SMS, not PORTAL, since an
/// applicant has no account).
export interface AdverseActionEmailContext {
  firstName: string
  addressLine1: string
  /// The full notice body (adverseActionNoticeText()) - the actual
  /// FCRA-required content, reproduced verbatim rather than summarized or
  /// linked, since an applicant has no portal to click through to.
  noticeText: string
}

export const applicationAdverseActionTemplate: NotificationTemplate<AdverseActionEmailContext> = {
  key: 'application.adverse_action',
  category: 'prospect_application',
  channels: ['EMAIL'],
  render: (context) => ({
    subject: `Notice of adverse action - ${context.addressLine1}`,
    body: [`Hi ${context.firstName},`, '', context.noticeText].join('\n'),
  }),
}

/// Context for `showing.invite` (LEASE-08, R-064) - the link to book a
/// slot, sent right after a prospect answers pre-screening.
export interface ShowingInviteContext {
  firstName: string
  addressLine1: string
  /// The prospect's own single-use SHOWING_BOOKING link.
  url: string
}

/**
 * "Book a showing" (LEASE-08's "self-serve slot booking"). A code template,
 * same reasoning `prospectPrescreenTemplate`'s own comment gives - not
 * per-property editable, so it stays out of R-049's managed-template
 * carrier.
 */
export const showingInviteTemplate: NotificationTemplate<ShowingInviteContext> = {
  key: 'showing.invite',
  category: 'prospect_showing',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    if (channel === 'SMS') {
      return {
        body: [`Ready to see ${context.addressLine1}? Book a time that works:`, context.url].join(
          '\n',
        ),
      }
    }
    return {
      subject: `Book a showing - ${context.addressLine1}`,
      body: [
        `Hi ${context.firstName},`,
        '',
        `Pick a time that works for you to see ${context.addressLine1}:`,
        '',
        context.url,
      ].join('\n'),
    }
  },
}

/// Context for `showing.scheduled` (LEASE-08, R-064) - a prospect's own
/// booking confirmation, and its T-1-day/T-2-hour reminders.
export interface ShowingContext {
  firstName: string
  addressLine1: string
  unitName: string
  scheduledStart: string
  scheduledEnd: string
  timezone: string
  /// Set on the two reminder sweeps, same trick `EntryNoticeContext.isReminder`
  /// uses to read confirmation and reminder as different messages sharing
  /// one template.
  isReminder?: boolean
}

/**
 * A showing booking confirmation, and its T-1-day/T-2-hour reminders
 * (LEASE-08: "SMS reminders send - no-show reduction").
 */
export const showingTemplate: NotificationTemplate<ShowingContext> = {
  key: 'showing.scheduled',
  category: 'prospect_showing',
  channels: ['SMS', 'EMAIL'],
  render: (context, channel) => {
    const window = formatEntryWindow(
      new Date(context.scheduledStart),
      new Date(context.scheduledEnd),
      context.timezone,
    )
    const lead = context.isReminder ? 'Reminder' : "You're booked"

    if (channel === 'SMS') {
      return {
        body: [`${lead}: showing at ${context.addressLine1}`, window].join('\n'),
      }
    }
    return {
      subject: `${lead}: your showing at ${context.addressLine1}`,
      body: [
        `Hi ${context.firstName},`,
        '',
        context.isReminder
          ? 'A reminder about the showing you booked:'
          : `You're booked to see ${context.addressLine1}${context.unitName ? ` (${context.unitName})` : ''}:`,
        '',
        window,
        '',
        'A member of our team will meet you there.',
      ].join('\n'),
    }
  },
}

export const TEMPLATES: Readonly<Record<string, NotificationTemplate<never>>> = {
  [vendorDeclinedTemplate.key]:
    vendorDeclinedTemplate as unknown as NotificationTemplate<never>,
  [vendorMessageTemplate.key]:
    vendorMessageTemplate as unknown as NotificationTemplate<never>,
  [unitMakeReadyTemplate.key]:
    unitMakeReadyTemplate as unknown as NotificationTemplate<never>,
  [maintenanceEmergencyTemplate.key]:
    maintenanceEmergencyTemplate as unknown as NotificationTemplate<never>,
  [vendorDispatchTemplate.key]:
    vendorDispatchTemplate as unknown as NotificationTemplate<never>,
  [vendorBidRequestTemplate.key]:
    vendorBidRequestTemplate as unknown as NotificationTemplate<never>,
  [autopayPredebitTemplate.key]:
    autopayPredebitTemplate as unknown as NotificationTemplate<never>,
  [entryNoticeTemplate.key]:
    entryNoticeTemplate as unknown as NotificationTemplate<never>,
  [emergencyEscalationTemplate.key]:
    emergencyEscalationTemplate as unknown as NotificationTemplate<never>,
  [verifyRequestTemplate.key]:
    verifyRequestTemplate as unknown as NotificationTemplate<never>,
  [paymentReceiptTemplate.key]:
    paymentReceiptTemplate as unknown as NotificationTemplate<never>,
  [paymentReturnedTemplate.key]:
    paymentReturnedTemplate as unknown as NotificationTemplate<never>,
  [chargebackPostedTemplate.key]:
    chargebackPostedTemplate as unknown as NotificationTemplate<never>,
  [managedTemplate.key]:
    managedTemplate as unknown as NotificationTemplate<never>,
  [announcementTemplate.key]:
    announcementTemplate as unknown as NotificationTemplate<never>,
  [rentDueTemplate.key]: rentDueTemplate as unknown as NotificationTemplate<never>,
  [paymentFailedFixTemplate.key]:
    paymentFailedFixTemplate as unknown as NotificationTemplate<never>,
  [cardExpiringTemplate.key]:
    cardExpiringTemplate as unknown as NotificationTemplate<never>,
  [digestTemplate.key]: digestTemplate as unknown as NotificationTemplate<never>,
  [prospectPrescreenTemplate.key]:
    prospectPrescreenTemplate as unknown as NotificationTemplate<never>,
  [applicationInviteTemplate.key]:
    applicationInviteTemplate as unknown as NotificationTemplate<never>,
  [coApplicantInviteTemplate.key]:
    coApplicantInviteTemplate as unknown as NotificationTemplate<never>,
  [applicationFeePaidTemplate.key]:
    applicationFeePaidTemplate as unknown as NotificationTemplate<never>,
  [applicationAdverseActionTemplate.key]:
    applicationAdverseActionTemplate as unknown as NotificationTemplate<never>,
  [leaseSignInviteTemplate.key]:
    leaseSignInviteTemplate as unknown as NotificationTemplate<never>,
  [showingTemplate.key]: showingTemplate as unknown as NotificationTemplate<never>,
  [showingInviteTemplate.key]: showingInviteTemplate as unknown as NotificationTemplate<never>,
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
