import { OPEN_TICKET_STATUSES } from '@rental/core/comms'
import { OPEN_WORK_ORDER_STATUSES } from '@rental/core/workorders'
import { describe, expect, it } from 'vitest'
import { MAINTENANCE, buildPlan } from './demo-seed.mts'

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
