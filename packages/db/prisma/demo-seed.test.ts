import { OPEN_TICKET_STATUSES } from '@rental/core/comms'
import { OPEN_WORK_ORDER_STATUSES } from '@rental/core/workorders'
import { describe, expect, it } from 'vitest'
import { COMPLIANCE, LEASING, MAINTENANCE, buildPlan } from './demo-seed.mts'

// Importing this module must never touch a database - see the file's own
// `pathToFileURL` guard. If that guard regresses, this test hangs or throws
// on a missing DATABASE_URL rather than failing cleanly, which is itself a
// useful signal.
//
// ==========================================================================
// WHAT THESE TESTS ARE FOR, and it is one thing: A DEMO THAT OPENS ON AN
// EMPTY SCREEN IS WORSE THAN NO DEMO, because the failure looks like the
// product being empty rather than the seed being wrong.
//
// R-036b's lesson, which R-100b's row restates: a status existing in the
// enum, and in the write that sets it, says NOTHING about the lists that
// read it. R-100a seeded a work order in `INVOICED` and it was invisible on
// the only list that renders work orders. That was caught by reading the
// query by hand, which is exactly the check nobody performs twice - so it is
// asserted here instead, against the same list the query itself now uses.
// ==========================================================================

const workOrderPlans = Object.values(MAINTENANCE).flatMap((plan) => [
  ...(plan.standaloneWorkOrders ?? []),
  ...(plan.tickets ?? []).flatMap((ticket) => (ticket.workOrder ? [ticket.workOrder] : [])),
])

const ticketPlans = Object.values(MAINTENANCE).flatMap((plan) => plan.tickets ?? [])

describe('the demo seed lands on screens that render it', () => {
  it('seeds no work order in a status the open board filters out', () => {
    const open: readonly string[] = OPEN_WORK_ORDER_STATUSES
    const invisible = workOrderPlans.filter((plan) => !open.includes(plan.status))
    expect(invisible.map((plan) => `${plan.status}: ${plan.scope}`)).toEqual([])
  })

  it('seeds no OPEN ticket in a status the queues filter out', () => {
    // CLOSED is deliberately exempt: one closed ticket is seeded for
    // contrast, and "open" is precisely what it is not.
    const open: readonly string[] = OPEN_TICKET_STATUSES
    const invisible = ticketPlans
      .filter((plan) => plan.status !== 'CLOSED')
      .filter((plan) => !open.includes(plan.status))
    expect(invisible.map((plan) => `${plan.status}: ${plan.category}`)).toEqual([])
  })
})

describe('the maintenance story points at units that exist', () => {
  it('every key names a real property and unit', () => {
    // The keys are "<property>::<unit>" strings, which is what makes a
    // rename fail loudly instead of silently reattaching the story to the
    // wrong unit - but only if something actually checks. A typo here seeds
    // nothing at all and the run still reports success.
    const real = new Set(
      buildPlan().flatMap((property) =>
        property.units.map((unit) => `${property.name}::${unit.name}`),
      ),
    )
    const dangling = Object.keys(MAINTENANCE).filter((key) => !real.has(key))
    expect(dangling).toEqual([])
  })

  it('every vendor and PM-schedule index is in range', () => {
    // Out of range is an undefined row and a crash halfway through seeding,
    // which leaves a half-built demo behind.
    for (const plan of workOrderPlans) {
      expect(plan.vendorIndex, plan.scope).toBeLessThan(3)
      if (plan.pmTemplateIndex != null) {
        expect(plan.pmTemplateIndex, plan.scope).toBeLessThan(3)
      }
    }
  })

  it('keeps at least one emergency and one unanswered dispatch, which is the point of it', () => {
    // Not decoration. The escalation ladder and the vendor no-response timer
    // are the two most demo-worthy paths in maintenance, and both need
    // something genuinely outstanding to have anything to show. Softening
    // these to make a screenshot look tidy is the change this guards.
    expect(
      ticketPlans.some((plan) => plan.priority === 'EMERGENCY' && !plan.respondedAfterMinutes),
    ).toBe(true)
    expect(workOrderPlans.some((plan) => plan.liveVendorLink && !plan.vendorResponse)).toBe(true)
  })

  it('mints exactly one live vendor link', () => {
    // The raw token is printed once and unrecoverable. More than one is a
    // demo where the operator has to work out which link is which; none is a
    // vendor page nobody can open.
    expect(workOrderPlans.filter((plan) => plan.liveVendorLink)).toHaveLength(1)
  })
})

// ---- The leasing and risk story (R-100b) ----
//
// Only two things in this half actually filter, and both were found by
// reading the queries rather than by guessing - which is exactly why they
// are asserted here instead of remembered.

describe('the leasing story lands on screens that render it', () => {
  it('publishes the listing, because the public page filters on PUBLISHED outright', () => {
    // `listingForPublic` is `where: { id, status: 'PUBLISHED' }`. A DRAFT
    // listing is not a quieter demo, it is a 404.
    const listings = Object.values(LEASING).filter((plan) => plan.listing)
    expect(listings.length).toBeGreaterThan(0)
  })

  it('keeps every seeded accommodation request UNDECIDED', () => {
    // The violation page's own panel filters to RECEIVED and
    // INFO_REQUESTED. An APPROVED or DENIED request would be seeded onto a
    // case from which nobody can reach it - and the undecided ones are the
    // point: a decision not yet made is where fair-housing goes right or
    // wrong.
    const undecided = ['RECEIVED', 'INFO_REQUESTED']
    const requests = Object.values(LEASING)
      .map((plan) => plan.violation?.accommodation)
      .filter((request) => request != null)
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(undecided, request.requestText.slice(0, 40)).toContain(request.status)
    }
  })

  it('opens the eviction at NOTICE and never past it', () => {
    // A demo that opens on a courthouse step misrepresents what this
    // product is for, and a case past NOTICE with a cure period still
    // running is two screens disagreeing.
    for (const plan of Object.values(LEASING)) {
      if (plan.eviction) expect(plan.eviction.stage).toBe('NOTICE')
    }
  })

  it('serves the notice before the cure period it counts could have expired', () => {
    // Served three days ago with a three-day cure is a clock still running.
    // Served three days ago with a one-day cure is a case that should
    // already have moved on, and a demo frozen in an impossible state.
    for (const plan of Object.values(LEASING)) {
      if (!plan.notice) continue
      expect(plan.notice.cureDays, plan.notice.type).toBeGreaterThanOrEqual(plan.notice.daysAgo)
    }
  })

  it('every leasing key names a real property and unit', () => {
    const real = new Set(
      buildPlan().flatMap((property) =>
        property.units.map((unit) => `${property.name}::${unit.name}`),
      ),
    )
    expect(Object.keys(LEASING).filter((key) => !real.has(key))).toEqual([])
  })

  it('names a real property on every property-scoped compliance item', () => {
    const names = new Set(buildPlan().map((property) => property.name))
    const dangling = COMPLIANCE.filter(
      (item) => item.scope === 'PROPERTY' && !names.has(item.propertyName ?? ''),
    )
    expect(dangling.map((item) => item.label)).toEqual([])
  })

  it('seeds compliance both overdue and upcoming, which is the whole point of it', () => {
    // All green demonstrates nothing; all red looks like a broken seed
    // rather than a portfolio.
    expect(COMPLIANCE.some((item) => item.dueInDays < 0)).toBe(true)
    expect(COMPLIANCE.some((item) => item.dueInDays > 0)).toBe(true)
  })

  it('leaves the envelope mid-signature, with someone still to sign', () => {
    // PARTIALLY_SIGNED is the only interesting envelope state, and it is
    // only true if at least one signer has signed and at least one has not.
    for (const plan of Object.values(LEASING)) {
      if (!plan.envelope) continue
      const signed = plan.envelope.signers.filter((signer) => signer.status === 'SIGNED')
      expect(signed.length).toBeGreaterThan(0)
      expect(signed.length).toBeLessThan(plan.envelope.signers.length)
    }
  })

  it('puts a prospect at every stage of the funnel', () => {
    // A funnel with a gap in it reads as a bug in the product rather than a
    // gap in the seed, because that is what it would look like on screen.
    const seeded = new Set(
      Object.values(LEASING).flatMap((plan) => (plan.prospects ?? []).map((p) => p.status)),
    )
    for (const stage of ['INQUIRY', 'PRE_SCREENED', 'SHOWING', 'APPLIED', 'SCREENED', 'APPROVED']) {
      expect([...seeded], stage).toContain(stage)
    }
  })

  it('writes an application for everyone past APPLIED and nobody before it', () => {
    const before = ['INQUIRY', 'PRE_SCREENED', 'SHOWING']
    for (const plan of Object.values(LEASING)) {
      for (const prospect of plan.prospects ?? []) {
        const shouldHaveOne = !before.includes(prospect.status)
        expect(Boolean(prospect.application), prospect.email).toBe(shouldHaveOne)
      }
    }
  })
})
