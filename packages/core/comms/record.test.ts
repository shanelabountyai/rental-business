import { describe, expect, it } from 'vitest'
import {
  type CommsEntry,
  deliveryNarrative,
  hasNoDeliveryRecord,
  mergeCommsEntries,
  transcriptBlocks,
} from './index.ts'

// COMM-05's transcript. The tests worth having are about what the document
// CLAIMS - an overstated delivery status and a silently omitted notification
// are both defects that make the page look more authoritative, not less.

const AT = (day: number, hour = 9) => new Date(Date.UTC(2026, 2, day, hour))
const format = (instant: Date) => instant.toISOString().slice(0, 16).replace('T', ' ')

function entry(overrides: Partial<CommsEntry> = {}): CommsEntry {
  return {
    kind: 'MESSAGE',
    id: 'm1',
    occurredAt: AT(1),
    channel: 'SMS',
    direction: 'OUTBOUND',
    from: 'Alex Chen (staff) — management',
    to: 'Dana Reyes',
    body: 'Rent is due Friday.',
    deliveries: [],
    ...overrides,
  }
}

describe('mergeCommsEntries', () => {
  it('interleaves the three sources chronologically', () => {
    // The entire point of the item: a transcript built from Messages alone
    // omits every notification and notice, which for an ordinary tenancy is
    // most of what was ever sent.
    const merged = mergeCommsEntries(
      [entry({ id: 'msg', occurredAt: AT(3) })],
      [entry({ id: 'notif', kind: 'NOTIFICATION', occurredAt: AT(1) })],
      [entry({ id: 'notice', kind: 'NOTICE', occurredAt: AT(2) })],
    )
    expect(merged.map((e) => e.id)).toEqual(['notif', 'notice', 'msg'])
  })

  it('is deterministic when two entries share an instant', () => {
    // Two exports of an unchanged history must be byte-identical, or "is this
    // the transcript you gave me in March" stops being answerable.
    const a = entry({ id: 'zzz', kind: 'NOTICE', occurredAt: AT(1) })
    const b = entry({ id: 'aaa', kind: 'NOTIFICATION', occurredAt: AT(1) })
    expect(mergeCommsEntries([a], [b]).map((e) => e.id)).toEqual(
      mergeCommsEntries([b], [a]).map((e) => e.id),
    )
  })
})

describe('deliveryNarrative', () => {
  it('does NOT claim a message arrived when the provider merely accepted it', () => {
    // SENT has always meant "the provider took it", not "it arrived"
    // (R-040e). A transcript that printed "Delivered" for both would let a
    // landlord tell a court something the record does not support, and the
    // document's own authority is what would make it persuasive.
    const text = deliveryNarrative({ status: 'SENT', sentAt: AT(1) }, format)
    expect(text).toContain('accepted by the provider')
    expect(text).not.toContain('delivered')
  })

  it('keeps every timestamp, not just the newest', () => {
    // Read the moment it landed vs. read seven hours later is regularly the
    // point in dispute.
    const text = deliveryNarrative(
      { status: 'READ', deliveredAt: AT(1, 9), readAt: AT(1, 16) },
      format,
    )
    expect(text).toContain('delivered 2026-03-01 09:00')
    expect(text).toContain('read 2026-03-01 16:00')
  })

  it('explains a suppression in plain words', () => {
    expect(deliveryNarrative({ status: 'SUPPRESSED', detail: 'no_consent' }, format)).toBe(
      'not sent — no consent to text this person was on file',
    )
    expect(deliveryNarrative({ status: 'SUPPRESSED', detail: 'sms_opt_out' }, format)).toContain(
      'replied STOP',
    )
  })

  it('prints an unrecognised suppression reason raw rather than inventing one', () => {
    // A reason added to the vocabulary and not added here must LOOK
    // unfinished, not look explained.
    expect(deliveryNarrative({ status: 'SUPPRESSED', detail: 'quiet_hours' }, format)).toBe(
      'not sent — quiet_hours',
    )
  })

  it('carries the provider failure code on a failure', () => {
    const text = deliveryNarrative(
      { status: 'FAILED', detail: '21610', failedAt: AT(2) },
      format,
    )
    expect(text).toContain('failed')
    expect(text).toContain('21610')
  })
})

describe('hasNoDeliveryRecord', () => {
  it('flags an outbound entry with nothing recorded', () => {
    expect(hasNoDeliveryRecord(entry())).toBe(true)
  })

  it('does not flag an inbound one', () => {
    // Nobody records delivery of a message the tenant sent US.
    expect(hasNoDeliveryRecord(entry({ direction: 'INBOUND' }))).toBe(false)
  })

  it('does not flag one that has a delivery row', () => {
    expect(hasNoDeliveryRecord(entry({ deliveries: [{ status: 'DELIVERED' }] }))).toBe(false)
  })
})

describe('transcriptBlocks', () => {
  const base = {
    partyName: 'Dana Reyes',
    partyRole: 'Tenant',
    propertyName: 'Cedar Row',
    addressLine1: '12 Cedar Row',
    unitName: 'A',
    timezone: 'America/Chicago',
    generatedAt: '2 Apr 2026, 09:14 CDT',
    generatedBy: 'Alex Chen',
  }
  const textOf = (blocks: { text: string }[]) => blocks.map((b) => b.text).join('\n')

  it('states what the document contains and what it deliberately omits', () => {
    // Without it the reader supplies their own assumption - usually "this is
    // everything" - and a document that invites a false assumption is worse
    // than one that is obviously partial.
    const text = textOf(transcriptBlocks({ ...base, entries: [entry()] }, format))
    expect(text).toContain('every message exchanged with this party')
    expect(text).toContain('every notice served on them')
    expect(text).toContain('Internal staff notes are not communications')
    expect(text).toContain('America/Chicago')
  })

  it('says an outbound message has NO delivery record rather than leaving it blank', () => {
    // An absent delivery row and a failed one must not look alike on a page
    // somebody is going to argue from.
    const text = textOf(transcriptBlocks({ ...base, entries: [entry()] }, format))
    expect(text).toContain('no delivery confirmation was recorded')
  })

  it('renders every service event on a notice, not just the first', () => {
    // R-051's whole point: posted on the door AND mailed is one artifact and
    // two service events, and a state requiring both is not satisfied by one.
    const text = textOf(
      transcriptBlocks(
        {
          ...base,
          entries: [
            entry({
              kind: 'NOTICE',
              channel: 'Posted with photograph',
              body: 'You have three days to vacate.',
              deliveries: [
                { status: 'Posted with photograph', sentAt: AT(1) },
                { status: 'Certified mail', sentAt: AT(2), externalId: '9400111' },
              ],
            }),
          ],
        },
        format,
      ),
    )
    expect(text).toContain('Posted with photograph')
    expect(text).toContain('Certified mail')
    expect(text).toContain('9400111')
  })

  it('says an empty transcript is empty', () => {
    // "Nothing was sent" is a real and sometimes decisive finding; a document
    // that just stops after its header reads like a truncated file.
    const text = textOf(transcriptBlocks({ ...base, entries: [] }, format))
    expect(text).toContain('No communications are recorded')
  })

  it('reproduces the body verbatim', () => {
    const body = 'The heater is out.\n\nIt has been two days.'
    const text = textOf(
      transcriptBlocks({ ...base, entries: [entry({ body })] }, format),
    )
    expect(text).toContain(body)
  })
})
