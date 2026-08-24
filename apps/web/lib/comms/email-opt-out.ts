import 'server-only'

import { emailOptOutConfirmation } from '@rental/core/comms'
import {
  CATEGORY_LABELS,
  LOCKED_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  channelsFor,
  isLockedCategory,
} from '@rental/core/notifications'
import type { NotificationRecipientType } from '@rental/db'
import { prisma } from '@rental/db'
import { deliverOverChannel } from '@/lib/notifications/deliver.ts'

// Honouring "stop emailing me" (COMM-08, NOTIF-02; R-097e).
//
// ==========================================================================
// IT HONOURS WHAT IT CAN AND SAYS WHAT IT CANNOT, and the second half is the
// whole item.
//
// Four categories are locked on by NOTIF-02 - legal notices, entry notices,
// emergency maintenance, and lease-signing links - and no request from a
// recipient can switch them off, because a legal notice that did not arrive
// is a notice that was not served, and an entry notice is a statutory
// obligation of ours rather than a subscription of theirs.
//
// SO THE DANGEROUS OUTCOME IS NOT "we kept emailing them". It is a tenant who
// believes they have switched off every email, misses an entry notice, and
// finds somebody in their home - having been misled by us. That is why the
// confirmation names exactly what will still arrive, in `LOCKED_CATEGORIES`'
// own words, and why sending one more email to somebody who asked for none is
// the right call rather than a violation of the request.
// ==========================================================================

const BUSINESS_NAME = 'Rental Operations'

export interface OptOutOutcome {
  stopped: number
  stillSending: string[]
}

/**
 * Switches off every email a recipient is allowed to switch off, and tells
 * them what is left.
 *
 * ONLY EMAIL. An opt-out arriving by email says nothing about whether they
 * want a text at midnight about a burst pipe, and reading it as a
 * portfolio-wide silence would be a much larger inference than the sentence
 * supports. SMS has its own `STOP`, with a carrier behind it.
 *
 * NEVER THROWS INTO ITS CALLER. This runs after the message is already
 * filed - the tenant said what they said and that is recorded whatever
 * happens next - and a preferences write failing must not cost the record of
 * the request.
 */
export async function honourEmailOptOut(
  recipientType: NotificationRecipientType,
  recipientId: string,
  toAddress: string | null,
): Promise<OptOutOutcome> {
  const switchable: NotificationCategory[] = NOTIFICATION_CATEGORIES.filter(
    (category) => !isLockedCategory(category) && channelsFor(category).includes('EMAIL'),
  )

  for (const category of switchable) {
    await prisma.notificationPreference.upsert({
      where: {
        recipientType_recipientId_category_channel: {
          recipientType,
          recipientId,
          category,
          channel: 'EMAIL',
        },
      },
      // A deliberate override, which is exactly what this table holds - see
      // its own comment. Somebody asked; that is a deliberate choice.
      create: { recipientType, recipientId, category, channel: 'EMAIL', enabled: false },
      update: { enabled: false },
    })
  }

  const stillSending = NOTIFICATION_CATEGORIES.filter(
    (category) => isLockedCategory(category) && channelsFor(category).includes('EMAIL'),
  )

  if (toAddress) {
    const message = emailOptOutConfirmation({
      businessName: BUSINESS_NAME,
      stoppedCount: switchable.length,
      stillSending: stillSending.map((category) => ({
        label: CATEGORY_LABELS[category],
        explanation: LOCKED_CATEGORIES[category] ?? '',
      })),
    })
    // Straight through `deliverOverChannel` rather than `notify()`: this is
    // not a category anybody has a preference about, and routing it through
    // the preference engine would mean the message telling somebody their
    // preferences changed could be suppressed by the change it is announcing.
    // The kill switch and the sandbox redirect still apply, because they live
    // in `deliverOverChannel` and cover everything.
    await deliverOverChannel({
      channel: 'EMAIL',
      to: toAddress,
      subject: message.subject,
      body: message.body,
    }).catch((error) => {
      console.error(`[email-opt-out] could not confirm to ${recipientType} ${recipientId}`, error)
    })
  }

  return { stopped: switchable.length, stillSending: stillSending.map((c) => CATEGORY_LABELS[c]) }
}
