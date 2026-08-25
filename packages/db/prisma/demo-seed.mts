// db:seed:demo - the walking-skeleton demo data (PRD §8, R-013): something
// realistic to look at, not the reference rows seed.mts maintains for every
// environment to function at all.
//
//   npm run db:seed:demo [-- --reset]
//
// Idempotent by default: if the first demo legal entity already exists, this
// no-ops rather than duplicating rows on a second run. `--reset` deletes
// every row this script owns (identified by the two fixed entity names
// below, walking child tables in FK order) and reseeds from scratch - the
// convenient path while iterating on what the demo data should look like.
//
// A caveat that bit R-014 once already: `reset()` finds rows by the CURRENT
// ENTITY_NAMES, so changing one of those names and running `--reset` in the
// same breath does not clean up the old-named rows - it leaves them orphaned
// and creates a second, fresh set under the new name. Renaming an entity
// here means deleting the stale one by hand once, the same way that first
// rename was cleaned up.
//
// Dates are computed relative to when the script runs, not hardcoded: the
// whole point of "late", "in-notice" and "moving out" tenants is that they
// stay late, in-notice and moving out whenever someone actually runs this,
// months from now, not just on the day this was written.
//
// No AuditLog entries - matches seed.mts's own reference-data rows, which are
// not real user actions either.
//
// THAT USED TO MEAN `--reset` COULD DO PLAIN DELETES, AND R-100a ENDED IT.
// The maintenance story needs conversations - a tenant reporting a leak, a
// vendor answering a dispatch - and `Message` is append-only by trigger, with
// `onDelete: Restrict` on every foreign key that reaches it. So a demo
// property whose tickets carry messages can no longer have its subtree
// deleted, exactly as an audited property already could not. `reset()` below
// now decides that per property and RETIRES the sticky ones whole, rather
// than deleting halfway down and failing on a trigger.

import { pathToFileURL } from 'node:url'
import { mintToken } from '@rental/core/auth'
import { threadKey } from '@rental/core/comms'
import { prisma } from '../index.ts'

// Deliberately avoid generic UI words in these names ("Properties", nav
// section labels, unit-status words) - an unscoped e2e locator elsewhere
// substring-matching this data is exactly the kind of collision R-014 found
// and fixed in shell.spec.ts and units.spec.ts; a boring name here is cheap
// insurance against the next one nobody has written yet.
const ENTITY_NAMES = ['Bluebonnet Holdings LLC', 'Sunshine Coast Holdings LLC']

// PORTFOLIO-LEVEL DEMO ROWS, which hang off no legal entity and so cannot be
// found the way everything else here is. Named in a constant for the same
// reason ENTITY_NAMES is: `reset()` identifies what it owns BY NAME, and a
// row this script creates but cannot name is a row it can never clean up.
// The same caveat applies - rename one of these and the old row is orphaned.
const VENDOR_NAMES = [
  'Hill Country Plumbing Co',
  'Lone Star Heating & Air',
  'Ridgeway Handyman Services',
] as const

const PM_TEMPLATE_NAMES = [
  'HVAC filter replacement',
  'Gutter clearing',
  'Water heater flush',
] as const

function daysFrom(offset: number): Date {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + offset)
  return date
}

/**
 * Everything `--reset` owns, cleaned up or retired.
 *
 * ==========================================================================
 * THE SHAPE OF THIS FUNCTION IS ONE RULE: A PROPERTY IS DELETED WHOLE OR
 * RETIRED WHOLE, NEVER UNPICKED FROM THE BOTTOM.
 *
 * Before R-100a it deleted the subtree unconditionally and retired only the
 * property itself when an `AuditLog` row made deletion impossible. That
 * worked because nothing beneath a property was undeletable. Seeding
 * conversations ended it: `Message` is append-only by trigger, and
 * `Message.ticketId` / `workOrderId` are `onDelete: Restrict` precisely
 * because a `SET NULL` cascade would be an UPDATE the trigger rejects. So a
 * delete that walks down to tickets now throws partway - having already
 * removed the charges, leases and tenants above them.
 *
 * A half-deleted property is worse than either outcome, which is why the
 * decision moved UP to the property and is made BEFORE anything is removed.
 * `sticky` below asks one question of each property - does anything
 * append-only point into it - and the two branches never mix.
 * ==========================================================================
 */
async function reset() {
  const entities = await prisma.legalEntity.findMany({
    where: { name: { in: ENTITY_NAMES } },
    select: { id: true },
  })
  const entityIds = entities.map((e) => e.id)
  if (entityIds.length === 0) return

  const properties = await prisma.property.findMany({
    where: { legalEntityId: { in: entityIds } },
    select: { id: true },
  })
  const propertyIds = properties.map((p) => p.id)

  // ---- WHICH PROPERTIES CANNOT BE DELETED, decided before anything goes ----
  //
  // Two sources of stickiness, and both are the product working rather than
  // an obstacle: the evidence trail deliberately outlives the entity it
  // describes.
  //
  //   AuditLog   - somebody used this demo property for real.
  //   Message    - a conversation happened on it. Found through Thread,
  //                which carries `propertyId` directly; every message this
  //                script writes lives in one, so this catches the
  //                ticket- and work-order-attached ones too without a
  //                second query that could disagree with this one.
  //
  // `LedgerEntry` and `Notification` are the other two append-only tables.
  // Neither is seeded here - D-11 forbids the first outright (R-100c owns
  // the money story) and nothing here sends - so neither is checked. If a
  // later item seeds one, it belongs in this set, and that is the whole
  // maintenance burden of this approach.
  const auditedPropertyIds = (
    await prisma.auditLog.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { propertyId: true },
      distinct: ['propertyId'],
    })
  ).map((row) => row.propertyId!)

  const conversedPropertyIds = (
    await prisma.thread.findMany({
      where: { propertyId: { in: propertyIds }, messages: { some: {} } },
      select: { propertyId: true },
      distinct: ['propertyId'],
    })
  ).map((row) => row.propertyId)

  const sticky = new Set([...auditedPropertyIds, ...conversedPropertyIds])
  const deletableProperties = propertyIds.filter((id) => !sticky.has(id))
  const stickyProperties = propertyIds.filter((id) => sticky.has(id))

  const stamp = new Date().toISOString().slice(0, 16)

  // ---- THE STICKY BRANCH: retire, touch nothing beneath ----
  //
  // Renamed and deactivated so the fresh seed neither collides with them nor
  // makes the demo look like it has twelve properties. Their tenants are
  // deactivated for the second reason only - a retired property's tenant
  // still showing as current would put a stranger in the demo's tenant list.
  //
  // Nothing else under them is touched at all. That is the point: the
  // subtree is evidence now, and evidence is not tidied up.
  if (stickyProperties.length > 0) {
    // KILL THE LIVE VENDOR LINKS FIRST. A retired work order that still
    // carries an unexpired `VENDOR_WORK_ORDER` token is a credential to a
    // gate code that nobody will ever think to revoke, and every reset would
    // add three more. `consumedAt` is what `vendorLinkAccess()` checks, and
    // setting it is exactly what `revokeVendorLinks` does in the product -
    // the same revocation, reached from the one place that knows these jobs
    // are being retired.
    const retiringWorkOrderIds = (
      await prisma.workOrder.findMany({
        where: { propertyId: { in: stickyProperties } },
        select: { id: true },
      })
    ).map((row) => row.id)
    await prisma.authToken.updateMany({
      where: {
        purpose: 'VENDOR_WORK_ORDER',
        subjectId: { in: retiringWorkOrderIds },
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    })

    const stickyLeases = await prisma.lease.findMany({
      where: { propertyId: { in: stickyProperties } },
      select: { id: true },
    })
    const stickyTenantIds = (
      await prisma.leaseTenant.findMany({
        where: { leaseId: { in: stickyLeases.map((l) => l.id) } },
        select: { tenantId: true },
      })
    ).map((lt) => lt.tenantId)

    await prisma.tenant.updateMany({
      where: { id: { in: stickyTenantIds } },
      data: { active: false },
    })

    for (const id of stickyProperties) {
      const property = await prisma.property.findUniqueOrThrow({ where: { id } })
      await prisma.property.update({
        where: { id },
        data: { active: false, name: `${property.name} (retired ${stamp})` },
      })
    }
  }

  // ---- THE CLEAN BRANCH: delete the subtree, in foreign-key order ----
  if (deletableProperties.length > 0) {
    const leaseIds = (
      await prisma.lease.findMany({
        where: { propertyId: { in: deletableProperties } },
        select: { id: true },
      })
    ).map((l) => l.id)

    const tenantIds = (
      await prisma.leaseTenant.findMany({
        where: { leaseId: { in: leaseIds } },
        select: { tenantId: true },
      })
    ).map((lt) => lt.tenantId)

    // Threads before tickets and work orders, because a thread names both.
    // Safe to delete outright here only because this branch is by definition
    // the properties whose threads hold NO messages - a thread with one is
    // what put its property in the other branch.
    await prisma.thread.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    await prisma.inspectionItem.deleteMany({
      where: { inspection: { propertyId: { in: deletableProperties } } },
    })
    await prisma.inspection.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // Work orders before tickets (WorkOrder.ticketId) and before the
    // preventive-maintenance templates further down (WorkOrder.pmTemplateId).
    await prisma.workOrder.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.ticket.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    await prisma.charge.deleteMany({ where: { leaseId: { in: leaseIds } } })
    await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
    await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await prisma.unit.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // JobRun first. It is machine bookkeeping, not evidence (D-9's own
    // split), so it CAN be deleted - and it has to be: its unique key is
    // (jobType, COALESCE(propertyId,''), businessDate), so the SET NULL a
    // property delete would cascade collides with whatever portfolio-wide
    // run already holds that slot.
    await prisma.jobRun.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.property.deleteMany({ where: { id: { in: deletableProperties } } })
  }

  // ---- PORTFOLIO-LEVEL ROWS, which belong to no property ----
  //
  // Vendors and PM templates are deleted only when nothing survives that
  // could still point at them - a retired property's work orders name both.
  // Attempted unconditionally and skipped on a foreign-key refusal would be
  // the shorter code and the wrong code: it would hide a real constraint
  // behind a swallowed error.
  if (stickyProperties.length === 0) {
    await prisma.preventiveMaintenanceTemplate.deleteMany({
      where: { name: { in: [...PM_TEMPLATE_NAMES] } },
    })
    await prisma.vendor.deleteMany({ where: { name: { in: [...VENDOR_NAMES] } } })
  } else {
    // RETIRED THE SAME WAY PROPERTIES ARE - deactivated AND RENAMED, and the
    // rename is the half that is easy to skip and wrong to skip. `reset()`
    // finds these rows by name; a retired vendor left holding its original
    // name is found again by the NEXT reset, which then tries to delete it
    // and is refused by the retired property's work orders still pointing at
    // it. Renaming takes it out of the search, exactly as it does for a
    // retired property.
    for (const vendor of await prisma.vendor.findMany({
      where: { name: { in: [...VENDOR_NAMES] } },
      select: { id: true, name: true },
    })) {
      await prisma.vendor.update({
        where: { id: vendor.id },
        data: { active: false, name: `${vendor.name} (retired ${stamp})` },
      })
    }
    for (const template of await prisma.preventiveMaintenanceTemplate.findMany({
      where: { name: { in: [...PM_TEMPLATE_NAMES] } },
      select: { id: true, name: true },
    })) {
      await prisma.preventiveMaintenanceTemplate.update({
        where: { id: template.id },
        data: { active: false, name: `${template.name} (retired ${stamp})` },
      })
    }
  }

  // Entities go only if every one of their properties did. An entity still
  // holding a retired property has to stay, or the retired rows would be
  // orphaned - and it is renamed for the same reason the properties are:
  // ENTITY_NAMES is what the next run looks for.
  for (const entityId of entityIds) {
    const remaining = await prisma.property.count({ where: { legalEntityId: entityId } })
    if (remaining === 0) {
      await prisma.legalEntity.delete({ where: { id: entityId } })
      continue
    }
    const entity = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })
    await prisma.legalEntity.update({
      where: { id: entityId },
      data: { name: `${entity.name} (retired ${stamp})` },
    })
  }

  console.info(
    stickyProperties.length > 0
      ? `Reset: removed ${deletableProperties.length} demo propert${deletableProperties.length === 1 ? 'y' : 'ies'} and retired ${stickyProperties.length} that already carry an audit trail or a conversation.`
      : 'Reset: removed previous demo data.',
  )
}

interface UnitPlan {
  name: string
  status: 'OCCUPIED' | 'VACANT' | 'MAKE_READY' | 'DOWN'
  marketRentCents: number
  bedrooms: number
  bathrooms: number
  /// Present only for units that get an occupying tenant.
  tenant?: {
    firstName: string
    lastName: string
    email: string
    /// E.164, because that is the only form inbound SMS routing compares
    /// against (R-017). A demo tenant with a prettily-formatted number would
    /// silently never match an inbound text.
    phone: string
    lifecycle: string
    lease: {
      status: 'ACTIVE' | 'MONTH_TO_MONTH'
      startsOn: Date
      endsOn?: Date
      rentCents: number
      depositCents: number
      isMonthToMonth?: boolean
      moveOutAt?: Date
      noticeGivenAt?: Date
      /// A single overdue rent charge, standing in for "late" - no Payment
      /// or LedgerEntry rows here (D-11: those are a Stripe-webhook
      /// projection, never written directly). A Charge is fair game - it is
      /// core-computed and pushed TO Stripe, not sourced FROM it (D-12).
      overdueCharge?: boolean
    }
  }
  /// In-flight operational work for this unit (R-100a). Independent of
  /// `tenant` on purpose: a vacant unit mid-turn is exactly where the most
  /// interesting work order lives.
  maintenance?: MaintenancePlan
}

/**
 * The operational story for one unit (R-100a).
 *
 * IN-FLIGHT WORK, NOT HISTORY. The demo's job is to open on screens that
 * have something on them, and every queue in this product is a queue of
 * things that are not finished - so the plan below is weighted towards
 * tickets awaiting triage, a vendor who has not answered yet, and an
 * inspection that is due. One completed job and one locked inspection are
 * there for contrast, because a board where nothing has ever finished looks
 * just as unreal as an empty one.
 *
 * Attached to the UNIT rather than the property because that is what every
 * one of these rows is scoped to, and it keeps a job on a duplex pointing at
 * the half it actually happened in.
 */
interface TicketPlan {
  category: string
  description: string
  priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE'
  status: 'NEW' | 'TRIAGED' | 'WAITING_ON_TENANT' | 'CONVERTED' | 'CLOSED'
  source: 'PORTAL' | 'SMS' | 'EMAIL' | 'PHONE_LOGGED' | 'STAFF'
  daysAgo: number
  habitability?: boolean
  /// Minutes after creation that somebody first responded. Absent means
  /// nobody has - which is the state the emergency queue exists to surface,
  /// so at least one ticket here deliberately leaves it out.
  respondedAfterMinutes?: number
  /// A short exchange on the tenant's thread, oldest first. `from` is who
  /// spoke; the thread itself is continuous across every ticket the tenant
  /// ever raises (COMM-01), so these are tagged onto the ticket rather than
  /// living in a thread of their own.
  conversation?: { from: 'TENANT' | 'STAFF'; body: string; minutesAfter: number }[]
  workOrder?: WorkOrderPlan
}

interface WorkOrderPlan {
  scope: string
  status: 'ASSIGNED' | 'SCHEDULED' | 'IN_PROGRESS' | 'WORK_COMPLETE' | 'INVOICED'
  priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE'
  /// Index into VENDOR_NAMES.
  vendorIndex: 0 | 1 | 2
  estimateCents: number
  approvedAmountCents?: number
  /// Days from now - negative is past, positive is a booked future window.
  scheduledInDays?: number
  invoiceCents?: number
  /// THE LIVE LINK (D-6, R-025). Exactly one work order in this seed carries
  /// it: a demo needs a vendor page somebody can actually open, and the raw
  /// token exists only in the moment it is minted - it is printed once at the
  /// end of the run and is unrecoverable afterwards, because only its
  /// SHA-256 is stored.
  liveVendorLink?: boolean
  /// What the vendor said back, where they have answered at all.
  vendorResponse?: 'ACCEPTED' | 'DECLINED' | 'PROPOSED_TIME'
  /// A message on the vendor's own per-job thread.
  vendorConversation?: { from: 'STAFF' | 'VENDOR'; body: string; minutesAfter: number }[]
  /// Index into PM_TEMPLATE_NAMES, for a job a schedule raised rather than a
  /// tenant.
  pmTemplateIndex?: 0 | 1 | 2
}

interface InspectionPlan {
  type: 'MOVE_IN' | 'MOVE_OUT' | 'PRE_MOVE_OUT' | 'PERIODIC' | 'SEASONAL' | 'DRIVE_BY'
  /// Negative for one already walked, positive for one still to come.
  inDays: number
  /// Present only for an inspection that has been performed. A scheduled one
  /// carries its checklist unanswered, which is what makes the "due" state
  /// look like anything on screen.
  performed?: boolean
  items: { room: string; item: string; condition?: 'GOOD' | 'FAIR' | 'POOR' | 'DAMAGED' }[]
}

interface MaintenancePlan {
  tickets?: TicketPlan[]
  /// A job with no ticket behind it - preventive work, or a turn.
  standaloneWorkOrders?: WorkOrderPlan[]
  inspections?: InspectionPlan[]
}

interface PropertyPlan {
  legalEntityIndex: 0 | 1
  name: string
  addressLine1: string
  city: string
  state: string
  postalCode: string
  timezone: string
  propertyType:
    | 'SINGLE_FAMILY'
    | 'DUPLEX'
    | 'TOWNHOUSE'
    | 'CONDO'
  acquiredOn?: Date
  units: UnitPlan[]
}

/**
 * The maintenance story, keyed by "<property name>::<unit name>".
 *
 * A SEPARATE MAP MERGED IN BELOW, rather than another nested field inside
 * the property literal. Two reasons and the second is the one that matters:
 * the literal is already two hundred lines and this would push the tenant
 * details off the same screen as the unit they belong to; and a key that
 * names its property and unit in words fails loudly when a unit is renamed,
 * where a nested field would silently move with it and be attached to the
 * wrong story.
 */
export const MAINTENANCE: Record<string, MaintenancePlan> = {
  // THE EMERGENCY NOBODY HAS PICKED UP. `respondedAfterMinutes` is
  // deliberately absent and `acknowledgedAt` is never set, because the
  // escalation ladder (R-029/R-102b) and the emergency queue only have
  // anything to show when a page is genuinely outstanding. This is the
  // single most demo-worthy row in the file.
  'Riverside Court Duplex::Unit A': {
    tickets: [
      {
        category: 'Plumbing',
        description:
          'Water coming up through the kitchen floor by the dishwasher. It is spreading and I have towels down.',
        priority: 'EMERGENCY',
        status: 'NEW',
        source: 'SMS',
        daysAgo: 0,
        habitability: true,
        conversation: [
          {
            from: 'TENANT',
            body: 'Water coming up through the kitchen floor by the dishwasher. It is spreading and I have towels down.',
            minutesAfter: 0,
          },
        ],
      },
    ],
  },

  // MID-CONVERSATION, WAITING ON THE TENANT. The state a triage queue is
  // mostly made of and the one a screenshot never shows.
  'Riverside Court Duplex::Unit B': {
    tickets: [
      {
        category: 'Appliance',
        description: 'Dryer runs but the clothes come out damp.',
        priority: 'ROUTINE',
        status: 'WAITING_ON_TENANT',
        source: 'PORTAL',
        daysAgo: 3,
        respondedAfterMinutes: 95,
        conversation: [
          { from: 'TENANT', body: 'Dryer runs but the clothes come out damp.', minutesAfter: 0 },
          {
            from: 'STAFF',
            body: 'Thanks for letting us know. Before we send someone out — is the vent hose behind the dryer kinked or disconnected? A photo of the back of the unit would help.',
            minutesAfter: 95,
          },
        ],
      },
    ],
  },

  // A JOB BOOKED AND CONFIRMED, with the vendor's acceptance on the record.
  // The calendar and the entry-notice path both need one of these to render.
  'Bluebonnet Lane House::Main house': {
    tickets: [
      {
        category: 'HVAC',
        description: 'Upstairs is not cooling below 80 even with the unit running all afternoon.',
        priority: 'URGENT',
        status: 'CONVERTED',
        source: 'PORTAL',
        daysAgo: 5,
        respondedAfterMinutes: 40,
        conversation: [
          {
            from: 'TENANT',
            body: 'Upstairs is not cooling below 80 even with the unit running all afternoon.',
            minutesAfter: 0,
          },
          {
            from: 'STAFF',
            body: 'Booked Lone Star for Thursday between 9 and 12. You do not need to be home — we have permission to enter on file.',
            minutesAfter: 40,
          },
        ],
        workOrder: {
          scope: 'Diagnose weak cooling on the upstairs zone; recharge or replace capacitor as needed.',
          status: 'SCHEDULED',
          priority: 'URGENT',
          vendorIndex: 1,
          estimateCents: 42_000,
          approvedAmountCents: 42_000,
          scheduledInDays: 2,
          vendorResponse: 'ACCEPTED',
          vendorConversation: [
            {
              from: 'STAFF',
              body: 'Upstairs zone not cooling, tenant home most days. Can you take Thursday morning?',
              minutesAfter: 0,
            },
            { from: 'VENDOR', body: 'Thursday 9-12 works. Will bring a capacitor.', minutesAfter: 210 },
          ],
        },
      },
    ],
  },

  // THE VENDOR MID-DISPATCH, and the one live link in the seed. Dispatched
  // yesterday, no answer yet — which is what the no-response timer measures
  // and what makes the "chase the vendor" path visible.
  'Sunset Boulevard Townhouse::Main unit': {
    tickets: [
      {
        category: 'Plumbing',
        description: 'Slow drain in the hall bathroom, backing up into the tub.',
        priority: 'ROUTINE',
        status: 'CONVERTED',
        source: 'PHONE_LOGGED',
        daysAgo: 2,
        respondedAfterMinutes: 25,
        workOrder: {
          scope: 'Clear hall bathroom drain line; camera the stack if it recurs.',
          status: 'ASSIGNED',
          priority: 'ROUTINE',
          vendorIndex: 0,
          estimateCents: 28_000,
          liveVendorLink: true,
          vendorConversation: [
            {
              from: 'STAFF',
              body: 'Hall bath draining slowly and backing into the tub. Details and the gate code are on the link — can you take it this week?',
              minutesAfter: 0,
            },
          ],
        },
      },
    ],
  },

  // THE TURN, and the only finished job here. A vacant unit mid-make-ready
  // is where the maintenance spend report gets its numbers, so this one runs
  // all the way to an invoice.
  'Palm Avenue House::Main house': {
    standaloneWorkOrders: [
      {
        // WORK_COMPLETE RATHER THAN INVOICED, AND THE DIFFERENCE IS WHETHER
        // ANYBODY CAN SEE IT. `listOpenWorkOrders` filters to OPEN_STATUSES,
        // which does not include INVOICED - the work orders page says so in
        // its own comment - so a seeded INVOICED job is reachable only by
        // direct URL. This is R-036b's lesson exactly: a status existing in
        // the enum says nothing about the lists that READ it. Complete with
        // the vendor's bill already in is a real state, it is what R-100a
        // asked for in the first place, and it still feeds the spend report.
        scope: 'Make-ready: paint throughout, replace hall carpet, deep clean.',
        status: 'WORK_COMPLETE',
        priority: 'ROUTINE',
        vendorIndex: 2,
        estimateCents: 185_000,
        approvedAmountCents: 185_000,
        scheduledInDays: -6,
        invoiceCents: 191_500,
        vendorResponse: 'ACCEPTED',
      },
    ],
    inspections: [
      {
        type: 'MOVE_OUT',
        inDays: -9,
        performed: true,
        items: [
          { room: 'Kitchen', item: 'Countertops', condition: 'GOOD' },
          { room: 'Kitchen', item: 'Appliances', condition: 'GOOD' },
          { room: 'Living room', item: 'Walls and paint', condition: 'POOR' },
          { room: 'Hallway', item: 'Carpet', condition: 'DAMAGED' },
          { room: 'Bathroom', item: 'Tub and surround', condition: 'FAIR' },
        ],
      },
    ],
  },

  // AN INSPECTION THAT IS DUE. Unanswered items on purpose — a copied-in
  // checklist starts null rather than defaulted to a condition nobody
  // observed, and "due" only looks like anything on screen because of it.
  'Magnolia Drive House::Main house': {
    inspections: [
      {
        type: 'PRE_MOVE_OUT',
        inDays: 8,
        items: [
          { room: 'Kitchen', item: 'Countertops' },
          { room: 'Kitchen', item: 'Appliances' },
          { room: 'Living room', item: 'Walls and paint' },
          { room: 'Primary bedroom', item: 'Flooring' },
          { room: 'Bathroom', item: 'Tub and surround' },
        ],
      },
    ],
  },

  // PREVENTIVE WORK, raised by a schedule rather than a tenant. A down unit
  // with nobody in it is where this is least intrusive and most realistic.
  'Coral Way Condo::Unit 1': {
    standaloneWorkOrders: [
      {
        scope: 'Quarterly HVAC filter replacement.',
        status: 'ASSIGNED',
        priority: 'ROUTINE',
        vendorIndex: 1,
        estimateCents: 9_500,
        pmTemplateIndex: 0,
      },
    ],
  },

  // A closed ticket, so the history is not uniformly open.
  'Magnolia Drive House::ADU': {
    tickets: [
      {
        category: 'Locks and keys',
        description: 'Front door deadbolt sticking.',
        priority: 'ROUTINE',
        status: 'CLOSED',
        source: 'STAFF',
        daysAgo: 21,
        respondedAfterMinutes: 30,
      },
    ],
  },
}

export function buildPlan(): PropertyPlan[] {
  return [
    {
      legalEntityIndex: 0,
      name: 'Bluebonnet Lane House',
      addressLine1: '122 Bluebonnet Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78704',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'OCCUPIED',
          marketRentCents: 220000,
          bedrooms: 3,
          bathrooms: 2,
          tenant: {
            firstName: 'Maria',
            lastName: 'Alvarez',
            email: 'maria.alvarez@example.test',
            phone: '+15125550142',
            lifecycle: 'current',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-240),
              endsOn: daysFrom(125),
              rentCents: 220000,
              depositCents: 220000,
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 0,
      name: 'Riverside Court Duplex',
      addressLine1: '48 Riverside Ct',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
      units: [
        {
          name: 'Unit A',
          status: 'OCCUPIED',
          marketRentCents: 165000,
          bedrooms: 2,
          bathrooms: 1,
          tenant: {
            firstName: 'Derrick',
            lastName: 'Holt',
            email: 'derrick.holt@example.test',
            phone: '+15125550178',
            lifecycle: 'late',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-420),
              endsOn: daysFrom(35),
              rentCents: 165000,
              depositCents: 165000,
              overdueCharge: true,
            },
          },
        },
        {
          name: 'Unit B',
          status: 'OCCUPIED',
          marketRentCents: 160000,
          bedrooms: 2,
          bathrooms: 1,
          tenant: {
            firstName: 'Priya',
            lastName: 'Nair',
            email: 'priya.nair@example.test',
            phone: '+17135550119',
            lifecycle: 'in-notice',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-380),
              endsOn: daysFrom(20),
              rentCents: 160000,
              depositCents: 160000,
              noticeGivenAt: daysFrom(-10),
              moveOutAt: daysFrom(20),
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 0,
      // Still has a real ADU unit below (per this item's own "units incl. an
      // ADU" requirement) - just not spelled out in the property's own name,
      // for the same collision reason as the entity names above.
      name: 'Magnolia Drive House',
      addressLine1: '310 Magnolia Dr',
      city: 'San Antonio',
      state: 'TX',
      postalCode: '78201',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'OCCUPIED',
          marketRentCents: 195000,
          bedrooms: 3,
          bathrooms: 2,
          tenant: {
            firstName: 'Wanda',
            lastName: 'Combs',
            email: 'wanda.combs@example.test',
            phone: '+19045550163',
            lifecycle: 'moving-out',
            lease: {
              status: 'ACTIVE',
              startsOn: daysFrom(-365),
              endsOn: daysFrom(5),
              rentCents: 195000,
              depositCents: 195000,
              moveOutAt: daysFrom(5),
            },
          },
        },
        {
          name: 'ADU',
          status: 'VACANT',
          marketRentCents: 120000,
          bedrooms: 1,
          bathrooms: 1,
        },
      ],
    },
    {
      legalEntityIndex: 0,
      name: 'Sunset Boulevard Townhouse',
      addressLine1: '77 Sunset Blvd',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      timezone: 'America/Chicago',
      propertyType: 'TOWNHOUSE',
      acquiredOn: daysFrom(-45),
      units: [
        {
          name: 'Main unit',
          status: 'OCCUPIED',
          marketRentCents: 210000,
          bedrooms: 3,
          bathrooms: 2.5,
          tenant: {
            firstName: 'Grant',
            lastName: 'Okafor',
            email: 'grant.okafor@example.test',
            phone: '+19045550187',
            lifecycle: 'inherited-at-acquisition',
            lease: {
              // Started long before this property's acquiredOn above -
              // a tenancy the current owner inherited at closing, still
              // going, now month-to-month.
              status: 'MONTH_TO_MONTH',
              startsOn: daysFrom(-730),
              rentCents: 200000,
              depositCents: 200000,
              isMonthToMonth: true,
            },
          },
        },
      ],
    },
    {
      legalEntityIndex: 1,
      name: 'Palm Avenue House',
      addressLine1: '500 Palm Ave',
      city: 'Tampa',
      state: 'FL',
      postalCode: '33602',
      timezone: 'America/New_York',
      propertyType: 'SINGLE_FAMILY',
      units: [
        {
          name: 'Main house',
          status: 'MAKE_READY',
          marketRentCents: 230000,
          bedrooms: 3,
          bathrooms: 2,
        },
      ],
    },
    {
      legalEntityIndex: 1,
      name: 'Coral Way Condo',
      addressLine1: '14 Coral Way',
      city: 'Orlando',
      state: 'FL',
      postalCode: '32801',
      timezone: 'America/New_York',
      propertyType: 'CONDO',
      units: [
        {
          name: 'Unit 1',
          status: 'DOWN',
          marketRentCents: 175000,
          bedrooms: 2,
          bathrooms: 2,
        },
      ],
    },
  ]
}

interface SeedContext {
  propertyId: string
  unitId: string
  leaseId: string | null
  tenantId: string | null
  staffId: string
  vendorRows: { id: string; name: string }[]
  pmTemplateRows: { id: string }[]
  vendorLinks: { vendor: string; scope: string; url: string }[]
}

function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000)
}

/**
 * Gets or creates the thread a message belongs in.
 *
 * `threadKey` from core rather than a string built here (COMM-01). The key is
 * what makes get-or-create safe under concurrency in production, and a seed
 * that invented its own format would produce threads the real routing cannot
 * find - a demo conversation that no inbound reply would ever land in.
 */
async function threadFor(
  identity:
    | { scope: 'TENANT'; propertyId: string; tenantId: string }
    | { scope: 'VENDOR'; propertyId: string; vendorId: string; workOrderId?: string },
  extra: { leaseId?: string | null; ticketId?: string | null; workOrderId?: string | null },
) {
  const key = threadKey(identity)
  const found = await prisma.thread.findUnique({ where: { key }, select: { id: true } })
  if (found) return found
  return prisma.thread.create({
    data: {
      key,
      propertyId: identity.propertyId,
      tenantId: identity.scope === 'TENANT' ? identity.tenantId : null,
      vendorId: identity.scope === 'VENDOR' ? identity.vendorId : null,
      leaseId: extra.leaseId ?? null,
      ticketId: extra.ticketId ?? null,
      workOrderId: extra.workOrderId ?? null,
    },
    select: { id: true },
  })
}

/**
 * Writes one message and moves its thread's `lastMessageAt`.
 *
 * Both, always, and in that order - the denormalized column is what the
 * inbox sorts by, and a thread whose newest message is invisible to the sort
 * is a conversation that has effectively not arrived. Production writes them
 * in one transaction for the same reason.
 */
async function writeMessage(input: {
  threadId: string
  channel: 'SMS' | 'EMAIL' | 'PORTAL' | 'CALL_LOG'
  direction: 'INBOUND' | 'OUTBOUND'
  body: string
  sentAt: Date
  staffUserId?: string | null
  tenantId?: string | null
  vendorId?: string | null
  ticketId?: string | null
  workOrderId?: string | null
}) {
  await prisma.message.create({
    data: {
      threadId: input.threadId,
      channel: input.channel,
      direction: input.direction,
      body: input.body,
      sentAt: input.sentAt,
      staffUserId: input.staffUserId ?? null,
      tenantId: input.tenantId ?? null,
      vendorId: input.vendorId ?? null,
      ticketId: input.ticketId ?? null,
      workOrderId: input.workOrderId ?? null,
    },
  })
  await prisma.thread.update({
    where: { id: input.threadId },
    data: { lastMessageAt: input.sentAt },
  })
}

async function seedTicket(
  plan: TicketPlan,
  context: SeedContext,
): Promise<{ workOrders: number; messages: number }> {
  const openedAt = daysFrom(-plan.daysAgo)

  const ticket = await prisma.ticket.create({
    data: {
      propertyId: context.propertyId,
      unitId: context.unitId,
      leaseId: context.leaseId,
      tenantId: context.tenantId,
      source: plan.source,
      category: plan.category,
      description: plan.description,
      priority: plan.priority,
      status: plan.status,
      habitabilityFlag: plan.habitability ?? false,
      // `entryPermission` on the scheduled HVAC job is what lets the demo say
      // "you do not need to be home" without that being a fiction.
      entryPermission: plan.status === 'CONVERTED',
      firstResponseAt:
        plan.respondedAfterMinutes == null
          ? null
          : minutesFrom(openedAt, plan.respondedAfterMinutes),
      closedAt: plan.status === 'CLOSED' ? daysFrom(-plan.daysAgo + 2) : null,
      createdAt: openedAt,
    },
  })

  let messages = 0
  if (plan.conversation && context.tenantId) {
    const thread = await threadFor(
      { scope: 'TENANT', propertyId: context.propertyId, tenantId: context.tenantId },
      { leaseId: context.leaseId, ticketId: ticket.id },
    )
    for (const line of plan.conversation) {
      await writeMessage({
        threadId: thread.id,
        channel: plan.source === 'SMS' ? 'SMS' : 'PORTAL',
        direction: line.from === 'TENANT' ? 'INBOUND' : 'OUTBOUND',
        body: line.body,
        sentAt: minutesFrom(openedAt, line.minutesAfter),
        staffUserId: line.from === 'STAFF' ? context.staffId : null,
        tenantId: line.from === 'TENANT' ? context.tenantId : null,
        // Tagged at INSERT, which is the fast path production uses for a
        // reply sent from a job's own page. The alternative - a
        // WorkOrderMessageLink row - exists for messages tagged AFTER the
        // fact, and using it here would misrepresent how these were sent.
        ticketId: ticket.id,
      })
      messages++
    }
  }

  if (!plan.workOrder) return { workOrders: 0, messages }
  const written = await seedWorkOrder(plan.workOrder, { ...context, ticketId: ticket.id })
  return { workOrders: 1, messages: messages + written.messages }
}

async function seedWorkOrder(
  plan: WorkOrderPlan,
  context: SeedContext & { ticketId: string | null },
): Promise<{ messages: number }> {
  const vendor = context.vendorRows[plan.vendorIndex]!
  // Everything past SUBMITTED has been dispatched to somebody - that is what
  // ASSIGNED means - so the dispatch timestamp is derived from the state
  // rather than carried in the plan, where it could silently disagree with it.
  const dispatchedAt = daysFrom(plan.status === 'ASSIGNED' ? -1 : -4)

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: context.propertyId,
      unitId: context.unitId,
      ticketId: context.ticketId,
      vendorId: vendor.id,
      assignedStaffId: context.staffId,
      status: plan.status,
      priority: plan.priority,
      scope: plan.scope,
      estimateCents: plan.estimateCents,
      approvedByStaffId: plan.approvedAmountCents == null ? null : context.staffId,
      approvedAt: plan.approvedAmountCents == null ? null : daysFrom(-4),
      approvedAmountCents: plan.approvedAmountCents ?? null,
      dispatchedAt,
      vendorResponse: plan.vendorResponse ?? null,
      vendorRespondedAt: plan.vendorResponse ? daysFrom(-3) : null,
      scheduledStart: plan.scheduledInDays == null ? null : daysFrom(plan.scheduledInDays),
      scheduledEnd:
        plan.scheduledInDays == null
          ? null
          : minutesFrom(daysFrom(plan.scheduledInDays), 3 * 60),
      invoiceCents: plan.invoiceCents ?? null,
      pmTemplateId:
        plan.pmTemplateIndex == null ? null : context.pmTemplateRows[plan.pmTemplateIndex]!.id,
    },
  })

  if (plan.liveVendorLink) {
    // The same purpose and the same shape `issueVendorLink` writes (D-6,
    // D-16), minted here rather than by calling it: that function lives in
    // apps/web and this script is in packages/db. `mintToken` is core, which
    // both can reach - so the token itself is produced by the one function
    // that produces every other token in the product, and only the row
    // around it is written twice.
    const minted = mintToken('VENDOR_WORK_ORDER')
    await prisma.authToken.create({
      data: {
        purpose: 'VENDOR_WORK_ORDER',
        tokenHash: minted.tokenHash,
        subjectType: 'WorkOrder',
        subjectId: workOrder.id,
        expiresAt: minted.expiresAt,
        // What `vendorLinkAccess()` compares against whoever the work order
        // currently names - the check that stops a reassigned vendor's
        // un-expired link still opening a gate code.
        metadata: { vendorId: vendor.id },
      },
    })
    context.vendorLinks.push({
      vendor: vendor.name,
      scope: plan.scope,
      url: `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3100'}/vendor/${minted.token}`,
    })
  }

  let messages = 0
  for (const line of plan.vendorConversation ?? []) {
    const thread = await threadFor(
      {
        scope: 'VENDOR',
        propertyId: context.propertyId,
        vendorId: vendor.id,
        workOrderId: workOrder.id,
      },
      { workOrderId: workOrder.id, ticketId: context.ticketId },
    )
    await writeMessage({
      threadId: thread.id,
      channel: 'SMS',
      direction: line.from === 'VENDOR' ? 'INBOUND' : 'OUTBOUND',
      body: line.body,
      sentAt: minutesFrom(dispatchedAt, line.minutesAfter),
      staffUserId: line.from === 'STAFF' ? context.staffId : null,
      vendorId: line.from === 'VENDOR' ? vendor.id : null,
      workOrderId: workOrder.id,
    })
    messages++
  }

  return { messages }
}

async function seedInspection(plan: InspectionPlan, context: SeedContext) {
  const when = daysFrom(plan.inDays)
  const inspection = await prisma.inspection.create({
    data: {
      propertyId: context.propertyId,
      unitId: context.unitId,
      leaseId: context.leaseId,
      type: plan.type,
      scheduledFor: when,
      performedAt: plan.performed ? when : null,
      performedByStaffId: plan.performed ? context.staffId : null,
      // LOCKED WHEN PERFORMED, because that is the whole point of INSP-01:
      // the move-out comparison is only worth something if the record cannot
      // be edited after the damage is found. A demo showing an editable
      // completed inspection would misrepresent the one guarantee it makes.
      lockedAt: plan.performed ? when : null,
    },
  })

  await prisma.inspectionItem.createMany({
    data: plan.items.map((item, order) => ({
      inspectionId: inspection.id,
      room: item.room,
      item: item.item,
      // Null for an inspection nobody has walked yet - a copied-in checklist
      // row starts unanswered rather than defaulted to a condition nobody
      // observed, and `canFinishInspection()` depends on that being true.
      condition: plan.performed ? (item.condition ?? 'GOOD') : null,
      order,
    })),
  })
}

async function seedDemoData() {
  const existing = await prisma.legalEntity.findFirst({
    where: { name: ENTITY_NAMES[0] },
  })
  if (existing) {
    console.info('Demo data already seeded - pass --reset to rebuild it.')
    return
  }

  // STAFF ARE FOUND, NEVER CREATED HERE. `db:create-owner` owns making an
  // account, and it should stay the only thing that does - a seed script
  // that mints a login is a seed script that has an opinion about passwords.
  // Refused with the command to run rather than seeded around, because every
  // work order, inspection and staff reply below has to be attributable to
  // somebody, and a demo you cannot log into is not a demo.
  const staff = await prisma.staffUser.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!staff) {
    console.error(
      'No active staff user exists, and the demo data has to be attributable to one.\n' +
        'Run `npm run db:create-owner` first, then this again.',
    )
    process.exitCode = 1
    return
  }

  const entities = await Promise.all(
    ENTITY_NAMES.map((name) => prisma.legalEntity.create({ data: { name, type: 'LLC' } })),
  )

  // ---- Portfolio-level rows the per-unit story points at ----
  const vendors = [
    {
      name: VENDOR_NAMES[0],
      trades: ['plumbing'],
      contactName: 'Marisol Vega',
      phone: '+15125550111',
      email: 'dispatch@hillcountryplumbing.example',
      // The one who answers at 3am (R-029). Without an emergency-available
      // vendor the emergency ticket above has nowhere to go, and the demo
      // dead-ends on its most important screen.
      emergencyAvailable: true,
      w9OnFile: true,
      preferredRank: 1,
    },
    {
      name: VENDOR_NAMES[1],
      trades: ['hvac'],
      contactName: 'Dwayne Okafor',
      phone: '+15125550122',
      email: 'service@lonestarheatingair.example',
      w9OnFile: true,
      preferredRank: 1,
    },
    {
      name: VENDOR_NAMES[2],
      trades: ['general', 'carpentry', 'painting'],
      contactName: 'Priya Raman',
      phone: '+15125550133',
      email: 'office@ridgewayhandyman.example',
      // Deliberately WITHOUT a W-9, so the payment-blocked path (MAINT-11)
      // is reachable in the demo rather than only in a test.
      w9OnFile: false,
      preferredRank: 2,
    },
  ]
  const vendorRows = await Promise.all(
    vendors.map((vendor) =>
      prisma.vendor.create({ data: { ...vendor, serviceAreas: ['Austin', 'Round Rock'] } }),
    ),
  )

  const pmTemplateRows = await Promise.all(
    [
      { name: PM_TEMPLATE_NAMES[0], trade: 'hvac', intervalMonths: 3 },
      { name: PM_TEMPLATE_NAMES[1], trade: 'general', intervalMonths: 6 },
      { name: PM_TEMPLATE_NAMES[2], trade: 'plumbing', intervalMonths: 12 },
    ].map((template) =>
      prisma.preventiveMaintenanceTemplate.create({
        data: { ...template, createdByStaffId: staff.id },
      }),
    ),
  )

  let propertyCount = 0
  let unitCount = 0
  let tenantCount = 0
  let ticketCount = 0
  let workOrderCount = 0
  let inspectionCount = 0
  let messageCount = 0
  /// Printed at the very end. The raw token exists only here - only its
  /// SHA-256 reaches the database - so a link not printed on this run is a
  /// link nobody can ever open.
  const vendorLinks: { vendor: string; scope: string; url: string }[] = []

  for (const plan of buildPlan()) {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entities[plan.legalEntityIndex]!.id,
        name: plan.name,
        addressLine1: plan.addressLine1,
        city: plan.city,
        state: plan.state,
        postalCode: plan.postalCode,
        timezone: plan.timezone,
        propertyType: plan.propertyType,
        acquiredOn: plan.acquiredOn,
      },
    })
    propertyCount++

    for (const unitPlan of plan.units) {
      const unit = await prisma.unit.create({
        data: {
          propertyId: property.id,
          name: unitPlan.name,
          status: unitPlan.status,
          marketRentCents: unitPlan.marketRentCents,
          bedrooms: unitPlan.bedrooms,
          bathrooms: unitPlan.bathrooms,
        },
      })
      unitCount++

      if (!unitPlan.tenant) continue
      const { tenant: tenantPlan } = unitPlan

      const tenant = await prisma.tenant.create({
        data: {
          firstName: tenantPlan.firstName,
          lastName: tenantPlan.lastName,
          email: tenantPlan.email,
          phone: tenantPlan.phone,
          notes: `Demo tenant - lifecycle state: ${tenantPlan.lifecycle}.`,
        },
      })
      tenantCount++

      const lease = await prisma.lease.create({
        data: {
          propertyId: property.id,
          unitId: unit.id,
          status: tenantPlan.lease.status,
          startsOn: tenantPlan.lease.startsOn,
          endsOn: tenantPlan.lease.endsOn,
          rentCents: tenantPlan.lease.rentCents,
          depositCents: tenantPlan.lease.depositCents,
          isMonthToMonth: tenantPlan.lease.isMonthToMonth ?? false,
          moveOutAt: tenantPlan.lease.moveOutAt,
          noticeGivenAt: tenantPlan.lease.noticeGivenAt,
          // R-033/RISK-08. The inherited tenancy in this seed is the whole
          // reason the lifecycle list includes one - it must actually carry
          // the origin, or the demo shows a tenancy that looks like every
          // other one and the outstanding-items path never appears.
          // UNKNOWN, not the NOT_APPLICABLE default: nobody has established
          // where that deposit went, which is exactly the point.
          ...(tenantPlan.lifecycle === 'inherited-at-acquisition'
            ? { origin: 'INHERITED' as const, depositTransferStatus: 'UNKNOWN' as const }
            : {}),
          // Who gave notice, where the plan says notice was given - a bare
          // timestamp cannot tell a tenant's notice from a landlord's, and
          // they have completely different consequences downstream.
          ...(tenantPlan.lease.noticeGivenAt
            ? { noticeGivenBy: 'TENANT' as const }
            : {}),
        },
      })

      await prisma.leaseTenant.create({
        data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
      })

      if (tenantPlan.lease.overdueCharge) {
        await prisma.charge.create({
          data: {
            propertyId: property.id,
            leaseId: lease.id,
            type: 'RENT',
            amountCents: tenantPlan.lease.rentCents,
            description: 'Monthly rent',
            dueOn: daysFrom(-20),
          },
        })
      }
    }

    // ---- The operational story, once the units it points at exist ----
    for (const unitPlan of plan.units) {
      const maintenance = MAINTENANCE[`${plan.name}::${unitPlan.name}`]
      if (!maintenance) continue

      const unit = await prisma.unit.findFirstOrThrow({
        where: { propertyId: property.id, name: unitPlan.name },
        select: { id: true },
      })
      const lease = await prisma.lease.findFirst({
        where: { unitId: unit.id, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
        select: { id: true },
      })
      const leaseTenant = lease
        ? await prisma.leaseTenant.findFirst({
            where: { leaseId: lease.id, isPrimary: true },
            select: { tenantId: true },
          })
        : null

      const context = {
        propertyId: property.id,
        unitId: unit.id,
        leaseId: lease?.id ?? null,
        tenantId: leaseTenant?.tenantId ?? null,
        staffId: staff.id,
        vendorRows,
        pmTemplateRows,
        vendorLinks,
      }

      for (const ticketPlan of maintenance.tickets ?? []) {
        const written = await seedTicket(ticketPlan, context)
        ticketCount++
        workOrderCount += written.workOrders
        messageCount += written.messages
      }

      for (const workOrderPlan of maintenance.standaloneWorkOrders ?? []) {
        const written = await seedWorkOrder(workOrderPlan, { ...context, ticketId: null })
        workOrderCount++
        messageCount += written.messages
      }

      for (const inspectionPlan of maintenance.inspections ?? []) {
        await seedInspection(inspectionPlan, context)
        inspectionCount++
      }
    }
  }

  console.info(
    `Seeded demo data: ${entities.length} legal entities, ${propertyCount} properties, ` +
      `${unitCount} units, ${tenantCount} tenants, ${vendorRows.length} vendors, ` +
      `${pmTemplateRows.length} PM schedules, ${ticketCount} tickets, ` +
      `${workOrderCount} work orders, ${inspectionCount} inspections, ${messageCount} messages.`,
  )

  // LAST, ALONE, AND LOUD. This is the only output of the whole run that
  // cannot be recovered by looking at the database afterwards.
  for (const link of vendorLinks) {
    console.info(
      `\nLive vendor link - ${link.vendor}\n  ${link.scope}\n  ${link.url}\n` +
        '  (Shown once. Only the hash is stored, so re-run the seed to mint another.)',
    )
  }
}

async function main() {
  if (process.argv.includes('--reset')) await reset()
  await seedDemoData()
}

// Guarded, so that demo-seed.test.ts can import MAINTENANCE and buildPlan()
// without opening a database connection or seeding anything as a side
// effect - the same guard and the same reasoning as
// seed-lease-templates.mts, including `pathToFileURL` rather than a
// hand-built `file://` string: this repo's own path contains a space, which
// `import.meta.url` percent-encodes, so a naive comparison would silently
// never match and running the script directly would do nothing at all.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
