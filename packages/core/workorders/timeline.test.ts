import { describe, expect, it } from 'vitest'
import { workOrderTimelineText } from './index.ts'

const HEADER = {
  propertyName: '14 Magnolia Drive',
  addressLine1: '14 Magnolia Drive',
  unitName: 'Unit A',
  scope: 'Replace the water heater',
  workOrderStatus: 'CLOSED',
  timezone: 'America/Chicago',
}

describe('workOrderTimelineText', () => {
  it('states there is nothing recorded, rather than an empty body', () => {
    const text = workOrderTimelineText(HEADER, [])
    expect(text).toContain('Nothing recorded yet.')
  })

  it('includes the property, unit, scope and status', () => {
    const text = workOrderTimelineText(HEADER, [])
    expect(text).toContain('14 Magnolia Drive')
    expect(text).toContain('Unit A')
    expect(text).toContain('Replace the water heater')
    expect(text).toContain('CLOSED')
  })

  it('renders every entry attributed, timestamped and IN CHRONOLOGICAL ORDER', () => {
    // Fed deliberately OUT of order - the function sorts, not the caller,
    // because a caller that forgot would produce a chronologically wrong
    // transcript with nothing to catch it.
    const text = workOrderTimelineText(HEADER, [
      {
        kind: 'vendor_message',
        at: new Date('2026-08-03T14:00:00Z'),
        author: 'Kwan Plumbing',
        body: 'On site now.',
        channel: 'Portal',
      },
      {
        kind: 'ticket_submitted',
        at: new Date('2026-08-01T14:00:00Z'), // 9am Chicago
        author: 'Dana Reyes',
        body: 'The water heater is leaking.',
      },
      {
        kind: 'staff_note',
        at: new Date('2026-08-02T14:00:00Z'),
        author: 'Alex (staff)',
        body: 'Ordered the part, ETA Thursday.',
      },
    ])

    const dana = text.indexOf('Dana Reyes')
    const alex = text.indexOf('Alex (staff)')
    const kwan = text.indexOf('Kwan Plumbing')
    expect(dana).toBeGreaterThan(-1)
    expect(dana).toBeLessThan(alex)
    expect(alex).toBeLessThan(kwan)

    expect(text).toContain('The water heater is leaking.')
    expect(text).toContain('Ordered the part, ETA Thursday.')
    expect(text).toContain('On site now.')
    expect(text).toContain('(Portal)')
    // Property-local time (D-3): 14:00 UTC is 9am in Chicago.
    expect(text).toContain('09:00')
  })

  it('never presents itself as a formatted legal document', () => {
    // Distinct from R-027's entryNoticeText, which drafts something a
    // tenant reads as an official notice. This is a raw pull of the
    // record - COMM-05's own PDF-with-letterhead item is what formalizes
    // it, and conflating the two would let this text be mistaken for that.
    expect(workOrderTimelineText(HEADER, [])).toContain('not a formatted legal document')
  })

  it('omits the channel note when an entry has none', () => {
    const text = workOrderTimelineText(HEADER, [
      {
        kind: 'ticket_submitted',
        at: new Date('2026-08-01T14:00:00Z'),
        author: 'Dana Reyes',
        body: 'The water heater is leaking.',
      },
    ])
    expect(text).not.toMatch(/Dana Reyes \(/)
  })
})
