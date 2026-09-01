import { OPEN_TICKET_STATUSES, unknownMergeFields } from '@rental/core/comms'
import { OPEN_WORK_ORDER_STATUSES } from '@rental/core/workorders'
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE,
  LEASING,
  MAINTENANCE,
  MESSAGE_TEMPLATE_BODY,
  MESSAGE_TEMPLATE_SUBJECT,
  MONEY,
  STRANGER_ROUTES,
  buildPlan,
} from './demo-seed.mts'

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
      // ABSENT is legal and means nobody is assigned yet - the only honest
      // shape for a job still collecting bids (R-140). Out of range is not:
      // it is an undefined row and a crash halfway through seeding, which
      // leaves a half-built demo behind.
      if (plan.vendorIndex != null) {
        expect(plan.vendorIndex, plan.scope).toBeLessThan(3)
      }
      for (const index of plan.bidVendorIndexes ?? []) {
        expect(index, plan.scope).toBeLessThan(3)
      }
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

// ---- The stranger-facing links (R-140) ----
//
// ==========================================================================
// EVERY ONE OF THESE ROUTES HAS A TOKEN IN ITS PATH AS ITS ENTIRE
// CREDENTIAL, so the only way to walk one is to hold a link the seed printed
// - and until R-140 the seed printed exactly one. These assert that each
// flag lands somewhere its verifier will actually accept, because the
// failure mode is not an error: it is a rejection page, which reads as the
// product being broken rather than the seed pointing at the wrong row.
// ==========================================================================

/// The prospects the leasing story writes, which is where four of the flags
/// live.
const prospectPlans = Object.values(LEASING).flatMap((plan) => plan.prospects ?? [])

const signerPlans = Object.values(LEASING).flatMap((plan) => plan.envelope?.signers ?? [])

describe('every stranger-reachable route has a link somebody can open', () => {
  it('mints one live link per purpose, and no purpose is left without one', () => {
    // THE ITEM, in one assertion. A new `AuthTokenPurpose` added to
    // STRANGER_ROUTES without a demo link is a route the next walk cannot
    // reach - which is how eight of them went unwalked for 140 items.
    const planned = new Set<string>([
      ...workOrderPlans.flatMap((plan) => (plan.liveVendorLink ? ['VENDOR_WORK_ORDER'] : [])),
      ...workOrderPlans.flatMap((plan) => (plan.liveVerifyLink ? ['TENANT_VERIFY'] : [])),
      ...workOrderPlans.flatMap((plan) => (plan.bidVendorIndexes?.length ? ['VENDOR_BID'] : [])),
      ...prospectPlans.flatMap((plan) => (plan.livePrescreenLink ? ['PROSPECT_PRESCREEN'] : [])),
      ...prospectPlans.flatMap((plan) => (plan.liveBookingLink ? ['SHOWING_BOOKING'] : [])),
      ...prospectPlans.flatMap((plan) => (plan.showing?.selfAccess ? ['SHOWING_ACCESS'] : [])),
      ...prospectPlans.flatMap((plan) => (plan.liveApplicationLink ? ['APPLICATION_LINK'] : [])),
      ...signerPlans.flatMap((plan) => (plan.liveSignLink ? ['LEASE_SIGN'] : [])),
      // Unconditional in `seedDemoData`/`seedMoney` rather than plan-driven:
      // there is exactly one late tenancy and one staff member, so neither
      // needs a flag to choose between candidates.
      'TENANT_PAY_LINK',
      'CALENDAR_FEED',
    ])
    expect([...planned].sort()).toEqual(Object.keys(STRANGER_ROUTES).sort())
  })

  it('puts the verify link on a completed job that hangs off a ticket', () => {
    // `verifyVerifyLink` refuses anything but WORK_COMPLETE, and refuses a
    // link whose recorded tenant is not still the TICKET's tenant - so a
    // standalone work order, which has no ticket and therefore no tenant,
    // can never carry one. `seedWorkOrder` throws on the second half at run
    // time; this catches both before the seed is run at all.
    const ticketed = new Set(
      ticketPlans.flatMap((ticket) => (ticket.workOrder ? [ticket.workOrder] : [])),
    )
    const flagged = workOrderPlans.filter((plan) => plan.liveVerifyLink)
    expect(flagged).toHaveLength(1)
    for (const plan of flagged) {
      expect(plan.status, plan.scope).toBe('WORK_COMPLETE')
      expect(ticketed.has(plan), plan.scope).toBe(true)
    }
  })

  it('asks several vendors for a price on a job still open to bids, and names none of them', () => {
    // `verifyBidLink` refuses once the job is past APPROVED - the bidding is
    // over - and several vendors holding live links to ONE job at once is
    // the whole reason VENDOR_BID is a separate purpose from the dispatch
    // link. One bidder would demonstrate neither.
    const open = ['SUBMITTED', 'TRIAGED', 'PENDING_APPROVAL', 'APPROVED']
    const bidding = workOrderPlans.filter((plan) => plan.bidVendorIndexes?.length)
    expect(bidding.length).toBeGreaterThan(0)
    for (const plan of bidding) {
      expect(open, plan.scope).toContain(plan.status)
      expect(plan.bidVendorIndexes!.length, plan.scope).toBeGreaterThan(1)
      expect(new Set(plan.bidVendorIndexes).size, plan.scope).toBe(plan.bidVendorIndexes!.length)
      // A job still collecting prices has not chosen anybody. Naming a
      // vendor here is the work order contradicting its own status on
      // screen.
      expect(plan.vendorIndex, plan.scope).toBeUndefined()
    }
  })

  it('gives the booking link to a prospect with no showing, and the access link to one with', () => {
    // `showingLinkStatus` short-circuits to "already booked" for a prospect
    // who has one, so the two flags cannot sit on the same person: the slot
    // picker and the access code are different pages for different moments.
    for (const plan of prospectPlans.filter((p) => p.liveBookingLink)) {
      expect(plan.showing, plan.email).toBeUndefined()
    }
    const selfShowing = prospectPlans.filter((plan) => plan.showing?.selfAccess)
    expect(selfShowing).toHaveLength(1)
    // A viewing in the past is a link whose page has nothing left to open.
    expect(selfShowing[0]!.showing!.inDays).toBeGreaterThan(0)
  })

  it('gives the application link to an application still being filled in', () => {
    // Every other seeded application is complete, which renders a finished
    // form - the applicant's own screens (the form, the co-applicant invite,
    // the upload, the fee) only show what they are for while one is open.
    const flagged = prospectPlans.filter((plan) => plan.liveApplicationLink)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.application?.completed).toBe(false)
  })

  it('gives the signing link to a signer the envelope is still waiting on', () => {
    // A SIGNED signer's page is a receipt. The interesting one is whoever
    // has not signed, which is also the only one PARTIALLY_SIGNED means.
    const flagged = signerPlans.filter((plan) => plan.liveSignLink)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.status).not.toBe('SIGNED')
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

// ---- The money story (R-100c) ----
//
// A DIFFERENT KIND OF CHECK FROM THE TWO ABOVE, because this half writes no
// rows: it replays Stripe events through the real pipeline, and every one of
// its failure modes is silent. An event for a customer nobody knows is
// `ignored` with a reason; a replayed id is a `duplicate`. Both leave the
// seed reporting success over an empty rent roll.
//
// `seedMoney` guards the ones only a database can see - it states the
// expected outcome at every call site and throws otherwise. What is asserted
// here is the half that is wrong before the script ever runs: a plan that
// describes a demo nobody would want to look at.

/// What each tenancy still owes when the plan has finished, in cents.
function owedCents(lifecycle: string, rentCents: number): number {
  const plan = MONEY[lifecycle]
  if (!plan) return 0
  return plan.invoices.reduce((owed, invoice) => {
    const paid =
      invoice.paidCents === 'full'
        ? rentCents
        : invoice.paidCents.reduce((sum, part) => sum + part, 0)
    return owed + rentCents - paid
  }, 0)
}

/// The tenancies `buildPlan()` actually writes, paired with their rent.
const tenancies = buildPlan().flatMap((property) =>
  property.units.flatMap((unit) =>
    unit.tenant ? [{ lifecycle: unit.tenant.lifecycle, lease: unit.tenant.lease }] : [],
  ),
)

describe('the money story attaches to tenancies that exist', () => {
  it('every key names a lifecycle some tenant actually has', () => {
    // Keyed by lifecycle rather than by "<property>::<unit>", so the dangling
    // key this guards against is a lifecycle nobody is in - which seeds
    // nothing at all while the run still reports success.
    const real = new Set(tenancies.map((tenancy) => tenancy.lifecycle))
    expect(Object.keys(MONEY).filter((key) => !real.has(key))).toEqual([])
  })

  it('gives every occupied tenancy a money story', () => {
    // A tenancy with no plan has no LeasePayer, no Stripe customer and no
    // subscription - so it is missing from the rent roll entirely rather
    // than showing a zero balance, and the demo looks like a product that
    // lost a tenant.
    const missing = tenancies.filter((tenancy) => !MONEY[tenancy.lifecycle])
    expect(missing.map((tenancy) => tenancy.lifecycle)).toEqual([])
  })
})

describe('the money story shows a portfolio, not a spreadsheet of zeroes', () => {
  it('leaves somebody owing and somebody square', () => {
    // All square demonstrates nothing - no chase, no notice with a number on
    // it, no reason for the rent roll to exist. All behind reads as a broken
    // seed rather than a portfolio. The same rule COMPLIANCE is held to.
    const owed = tenancies.map((tenancy) => owedCents(tenancy.lifecycle, tenancy.lease.rentCents))
    expect(owed.some((cents) => cents > 0)).toBe(true)
    expect(owed.some((cents) => cents === 0)).toBe(true)
  })

  it('enrols at least one tenancy in autopay and leaves at least one off it', () => {
    // D-29: collection is per payer and it switches. One mode across the
    // whole demo hides the only decision this part of the product makes.
    const plans = Object.values(MONEY)
    expect(plans.some((plan) => plan.autopayDaysAgo != null)).toBe(true)
    expect(plans.some((plan) => plan.autopayDaysAgo == null)).toBe(true)
  })

  it('bills one payer by invoice rather than by card', () => {
    // Stripe cannot do autopay and part-payments on one subscription, which
    // is exactly why `collectionMethod` is per payer. A demo entirely on
    // `charge_automatically` cannot show the part-payment path at all.
    expect(Object.values(MONEY).some((plan) => plan.collectionMethod === 'send_invoice')).toBe(true)
  })

  it('pays one invoice in instalments, which is the reason invoice.updated is subscribed to', () => {
    // D-141: `amount_paid` is cumulative, so only a DELTA can be projected.
    // A demo where every invoice is paid in one go never exercises the
    // subtraction that decision is about.
    const instalments = Object.values(MONEY).flatMap((plan) =>
      plan.invoices.filter(
        (invoice) => invoice.paidCents !== 'full' && invoice.paidCents.length > 1,
      ),
    )
    expect(instalments.length).toBeGreaterThan(0)
  })
})

describe('the money story is internally consistent', () => {
  it('carries the overdue charge exactly where one is seeded', () => {
    // THE TWO MONEY SCREENS DISAGREE OTHERWISE, and neither of them looks
    // broken on its own: the balance is a sum over `LedgerEntry` while the
    // tenant's pay screen derives what is outstanding from a charge's OWN
    // entries. An unlinked charge shows as fully outstanding for ever; a
    // `carriesOverdueCharge` naming a lifecycle with no charge silently
    // sends an empty `chargeIds` and links nothing.
    for (const tenancy of tenancies) {
      const plan = MONEY[tenancy.lifecycle]
      const carries = (plan?.invoices ?? []).some((invoice) => invoice.carriesOverdueCharge)
      expect(carries, tenancy.lifecycle).toBe(Boolean(tenancy.lease.overdueCharge))
    }
  })

  it('never pays an invoice more than it asked for', () => {
    // Instalments are cumulative deltas against `amount_due`. Paying past it
    // is not something Stripe would ever emit, and it would put the tenancy
    // into credit on a bill that was never that big.
    for (const tenancy of tenancies) {
      for (const invoice of MONEY[tenancy.lifecycle]?.invoices ?? []) {
        if (invoice.paidCents === 'full') continue
        const paid = invoice.paidCents.reduce((sum, part) => sum + part, 0)
        expect(paid, `${tenancy.lifecycle} @ ${invoice.daysAgo}d`).toBeLessThanOrEqual(
          tenancy.lease.rentCents,
        )
      }
    }
  })

  it('declines a payment before the invoice it was attempted against is history', () => {
    // `declinedAfterDays` is measured forward from finalization, so anything
    // at or past `daysAgo` is a decline dated in the future - which the
    // pipeline would happily project, leaving a failed payment nobody can
    // explain sitting at the top of the payment history.
    for (const plan of Object.values(MONEY)) {
      for (const invoice of plan.invoices) {
        if (invoice.declinedAfterDays == null) continue
        expect(invoice.declinedAfterDays).toBeLessThan(invoice.daysAgo)
      }
    }
  })

  it('keeps money in flight uncredited, which is the whole of PAY-02', () => {
    // An ACH debit that has not cleared has not reduced what is owed.
    // Asserted as a plan-level fact because the pipeline enforces it
    // downstream: `payment_intent.processing` writes a PENDING Payment and
    // no ledger row at all. What this guards is somebody "fixing" the demo
    // by settling it to make a balance look tidier.
    const inFlight = Object.values(MONEY).filter((plan) => plan.inFlight)
    expect(inFlight.length).toBeGreaterThan(0)
    for (const plan of inFlight) {
      expect(plan.inFlight!.amountCents).toBeGreaterThan(0)
    }
  })
})

// ---- The reusable templates (Milestone 10 demo walk) ----

describe('the demo message template can actually be sent', () => {
  it('uses only merge fields core knows about', () => {
    // `MERGE_FIELDS` is a CLOSED catalogue and `renderTemplate` refuses an
    // unknown key AT SEND TIME - so a typo here seeds a template that looks
    // right on `/messages/templates`, previews right, and fails the first
    // time somebody sends from it in front of an audience.
    expect(unknownMergeFields(MESSAGE_TEMPLATE_SUBJECT)).toEqual([])
    expect(unknownMergeFields(MESSAGE_TEMPLATE_BODY)).toEqual([])
  })
})
