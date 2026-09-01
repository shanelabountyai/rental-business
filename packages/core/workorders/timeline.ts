// The single exportable timeline (COMM-06, R-032). Pure - no database, no
// Next.js.
//
// COMM-06, verbatim: "Ticket- and work-order-related messages thread onto
// the ticket/WO itself - tenant thread, vendor thread, and staff notes hang
// off the same object with one exportable timeline. Reconstructing an
// incident from three separate text histories six months later for an
// insurance adjuster is the problem this solves."
//
// THIS FILE OWNS THE TEXT, NOT THE ASSEMBLY. Pulling the right rows out of
// Message/WorkOrderNote/Ticket is a database question and lives in
// apps/web/lib/workorders/timeline.ts, same split every other evidence
// document in this product uses (R-027's entryNoticeText is the model).
// What belongs here is turning an already-resolved, already-sorted list of
// entries into the transcript a PM hands to an adjuster - formatting logic
// worth testing without a database.

import { friendlyTimestamp } from '../scheduling/local-time.ts'

export const TIMELINE_ENTRY_KINDS = [
  /// The tenant's original report - synthesized from the Ticket itself, not
  /// a Message row. A portal or phone-logged submission never created one
  /// (there was nobody to transmit to), and inventing a fake Message to
  /// hold the description would blur the one real distinction this product
  /// keeps everywhere else: a Message is something that was SENT.
  'ticket_submitted',
  'tenant_message',
  'vendor_message',
  /// A staff reply, to either party - the channel field says which.
  'staff_message',
  'call_log',
  /// Internal only. Never a Message row - see WorkOrderNote's own schema
  /// comment for why.
  'staff_note',
] as const
export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number]

export interface TimelineEntry {
  kind: TimelineEntryKind
  at: Date
  /// Already resolved to a display name by the caller - "Dana Reyes", "Kwan
  /// Plumbing", "Alex (staff)". This file renders text; it does not know
  /// the schema well enough to resolve a name from an id.
  author: string
  body: string
  /// Present for message kinds - "Text", "Email", "Portal", "Phone call".
  channel?: string
}

export interface TimelineHeader {
  propertyName: string
  addressLine1: string
  unitName: string
  scope: string
  workOrderStatus: string
  /// Property-local, per D-3 - a transcript is read against what happened
  /// at the house, and every timestamp in the body renders in this zone.
  timezone: string
}

/**
 * The transcript itself.
 *
 * A DRAFT PULL OF THE RECORD, not a formatted legal packet - COMM-05's own
 * item (R-052, "thread export as a timestamped PDF transcript with delivery
 * metadata... the packet you hand an attorney, an adjuster or a judge") is
 * where a PDF with letterhead and signatures belongs. This is the plain-text
 * evidence itself: complete, chronological, attributed, and immediately
 * useful today rather than waiting on that later item.
 */
export function workOrderTimelineText(
  header: TimelineHeader,
  entries: readonly TimelineEntry[],
): string {
  const lines = [
    `Work order timeline`,
    '',
    `${header.propertyName} — ${header.addressLine1}${
      header.unitName ? ` (${header.unitName})` : ''
    }`,
    `Scope: ${header.scope}`,
    `Status: ${header.workOrderStatus}`,
    // NAMES THE ZONE (R-052, R-141). This was
    // `utcToWallClock(...).replace('T', ' ')` followed by the words
    // "(property-local time)" - which told a reader the clock was local to
    // somewhere without saying where. `friendlyTimestamp` prints the
    // abbreviation from the same resolution that picked the offset, so a
    // document generated on a DST boundary cannot label the wrong one, and
    // the parenthetical is no longer carrying the claim.
    `Generated: ${friendlyTimestamp(new Date(), header.timezone)}`,
    '',
  ]

  // Sorted here, not trusted from the caller. The whole value of this
  // document is that it reads in the order things actually happened; a
  // caller that forgot to sort would produce a chronologically wrong
  // transcript with nothing about the type system to catch it.
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime())

  if (sorted.length === 0) {
    lines.push('Nothing recorded yet.')
  } else {
    for (const entry of sorted) {
      const when = friendlyTimestamp(entry.at, header.timezone)
      lines.push(
        `[${when}] ${entry.author}${entry.channel ? ` (${entry.channel})` : ''}`,
        entry.body,
        '',
      )
    }
  }

  lines.push(
    '— This is a plain record pulled from the system. It is not a formatted legal document.',
  )

  return lines.join('\n')
}
