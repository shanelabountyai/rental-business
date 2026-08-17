// The printable communications transcript (COMM-05, R-052). Pure - what the
// page SAYS. Drawing it is `apps/web/lib/pdf/render.ts`.
//
// "Any thread exports as a timestamped PDF transcript with delivery metadata
// (court/adjuster packet)" - COMM-05, verbatim. The delivery metadata is the
// half that makes it evidence rather than a chat log: a transcript proving a
// tenant was told something is only as good as its record of whether the
// telling arrived.
//
// Distinct from R-032's `workOrderTimelineText`, deliberately. That is one
// INCIDENT reconstructed for an adjuster and includes internal staff notes;
// this is one PARTY's whole communications history and includes the
// notifications the engine sent them. Same evidence, two questions, and
// merging them would produce a document that answers neither well.

import type { DocumentBlock } from '../documents/blocks.ts'
import {
  type CommsEntry,
  deliveryNarrative,
  hasNoDeliveryRecord,
} from './record.ts'

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'Text message',
  EMAIL: 'Email',
  PORTAL: 'Portal message',
  CALL_LOG: 'Logged phone call',
}

const KIND_LABELS: Record<CommsEntry['kind'], string> = {
  MESSAGE: 'Message',
  NOTIFICATION: 'Automated notification',
  NOTICE: 'Served notice',
}

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel
}

export interface TranscriptFacts {
  /// "Jane Tenant" / "Kwan Plumbing" / the property, for a property thread.
  partyName: string
  /// "Tenant", "Vendor", "Property" - what the party is to us.
  partyRole: string
  propertyName: string
  addressLine1: string
  unitName?: string | null
  /// The property's IANA zone, printed so a reader elsewhere knows what the
  /// timestamps in the body are relative to (D-3).
  timezone: string
  /// Pre-formatted, in the property's zone, by the caller.
  generatedAt: string
  /// The staff member who produced it. A document handed to a court says who
  /// made it; "the system" is not a witness.
  generatedBy: string
  entries: readonly CommsEntry[]
}

/// D-4's standing requirement, and it earns its place here for a second
/// reason: a transcript is the document most likely to be forwarded to
/// somebody who will treat it as a legal filing.
export const TRANSCRIPT_DISCLAIMER =
  'This transcript is a record produced from this system and is not legal advice. It has not been reviewed by an attorney for this matter.'

/**
 * The blocks of a communications transcript, in order.
 *
 * THE COMPLETENESS STATEMENT IS NOT BOILERPLATE. A transcript's evidentiary
 * weight comes from a reader knowing what it does and does not contain, and
 * the header says so in plain words: which party, which property, which
 * sources, and what is deliberately absent. Without it the reader supplies
 * their own assumption - usually "this is everything" - and a document that
 * invites a false assumption is worse than one that is obviously partial.
 */
export function transcriptBlocks(
  facts: TranscriptFacts,
  format: (instant: Date) => string,
): DocumentBlock[] {
  const where = facts.unitName
    ? `${facts.propertyName} — ${facts.unitName}`
    : facts.propertyName

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'COMMUNICATIONS TRANSCRIPT' },
    { kind: 'meta', text: `${facts.partyRole}: ${facts.partyName}` },
    { kind: 'meta', text: `Property: ${where}` },
    { kind: 'meta', text: `Address: ${facts.addressLine1}` },
    { kind: 'meta', text: `Produced: ${facts.generatedAt}` },
    { kind: 'meta', text: `Produced by: ${facts.generatedBy}` },
    { kind: 'meta', text: `Entries: ${facts.entries.length}` },
    {
      kind: 'paragraph',
      text:
        'This transcript contains every message exchanged with this party, every automated notification addressed to them, and every notice served on them, that is recorded in this system for this property. ' +
        `All times are local to the property (${facts.timezone}). ` +
        'Internal staff notes are not communications and are not included.',
    },
  ]

  if (facts.entries.length === 0) {
    // An empty transcript must say it is empty. A document that simply stops
    // after its header reads like a truncated file, and "nothing was sent" is
    // a real and sometimes decisive finding that deserves to be stated.
    blocks.push({
      kind: 'paragraph',
      text: 'No communications are recorded for this party at this property.',
    })
    blocks.push({ kind: 'footer', text: TRANSCRIPT_DISCLAIMER })
    return blocks
  }

  for (const [index, entry] of facts.entries.entries()) {
    const arrow = entry.direction === 'INBOUND' ? 'Received' : 'Sent'
    blocks.push({
      kind: 'subheading',
      text: `${index + 1}. ${arrow} ${format(entry.occurredAt)} — ${channelLabel(entry.channel)}`,
    })
    blocks.push({ kind: 'meta', text: `Type: ${KIND_LABELS[entry.kind]}` })
    blocks.push({ kind: 'meta', text: `From: ${entry.from}` })
    blocks.push({ kind: 'meta', text: `To: ${entry.to}` })
    if (entry.subject) {
      blocks.push({ kind: 'meta', text: `Subject: ${entry.subject}` })
    }

    for (const delivery of entry.deliveries) {
      blocks.push({
        kind: 'meta',
        text: `Delivery: ${deliveryNarrative(delivery, format)}`,
      })
    }
    if (hasNoDeliveryRecord(entry)) {
      // Stated, never left blank - see hasNoDeliveryRecord's own comment. An
      // absent delivery row and a failed one must not look alike on a page
      // somebody is going to argue from.
      blocks.push({
        kind: 'meta',
        text: 'Delivery: no delivery confirmation was recorded for this message.',
      })
    }

    // The body verbatim. A `paragraph` block preserves the sender's own line
    // breaks through the renderer's wrap, and nothing here trims, tidies or
    // truncates it: the words as sent are the evidence.
    blocks.push({ kind: 'paragraph', text: entry.body })
  }

  blocks.push({
    kind: 'footer',
    text: `Transcript ends. ${facts.entries.length} ${facts.entries.length === 1 ? 'entry' : 'entries'}, ${format(facts.entries[0]!.occurredAt)} to ${format(facts.entries[facts.entries.length - 1]!.occurredAt)}.`,
  })
  blocks.push({ kind: 'footer', text: TRANSCRIPT_DISCLAIMER })

  return blocks
}
