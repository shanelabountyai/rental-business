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

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mintToken } from '@rental/core/auth'
import type { StripeEventEnvelope } from '@rental/core/billing'
import { threadKey } from '@rental/core/comms'
import { wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '../index.ts'
import { refuseUnlessDemoDatabase } from './demo-database-guard.mts'

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

/// The reusable checklist `/inspections/new` refuses to work without, and the
/// message template `/messages/templates` opens empty without. Named here for
/// the same reason `VENDOR_NAMES` is: `reset()` finds what it owns BY NAME.
///
/// Both screens were dead ends in the demo until the Milestone 10 walk opened
/// them - the inspections one visibly so, since "New inspection" answers "No
/// checklists yet. Build one first." while two walked inspections sit on the
/// list behind it. The seed built those from inline item plans and never
/// created the template a human would have had to build first.
const INSPECTION_TEMPLATE_NAME = 'Standard interior walk'
const MESSAGE_TEMPLATE_NAME = 'Rent reminder'

/// Exported so `demo-seed.test.ts` can hold them against core's CLOSED
/// merge-field catalogue. A `{{tenant.frist_name}}` here is refused at SEND
/// time, not at seed time - so the demo would ship a template that looks
/// perfect on the templates screen and fails in front of somebody.
export const MESSAGE_TEMPLATE_SUBJECT = 'Rent for {{property.name}} is due {{balance.due_on}}'
export const MESSAGE_TEMPLATE_BODY = [
  'Hi {{tenant.first_name}},',
  '',
  'This is a reminder that {{lease.rent}} of rent for {{property.name}} {{unit.name}} is due on {{balance.due_on}}. You currently owe {{balance.total}}.',
  '',
  'You can pay from your portal, or call us on {{company.phone}} if something has changed.',
  '',
  '{{company.name}}',
].join('\n')

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

/// Every demo property is in one zone, named once so a second zone cannot be
/// added without the times below being reconsidered.
const DEMO_ZONE = 'America/Chicago'

/**
 * An instant at a given wall-clock time on the property's own calendar day.
 *
 * `daysFrom` sets UTC MIDNIGHT, which is the right answer for a `@db.Date`
 * column and the wrong one for an appointment. Milestone 11's walk read
 * "Scheduled 2026-08-28 19:00 to 22:00" on a work order - the page is
 * correct, it renders `utcToWallClock(value, zone)` and says so in a comment
 * - so every vendor visit this seed had ever written was a 7pm-to-10pm
 * evening call, five hours off the business day, sitting directly above the
 * entry-notice line that DOES compute in property-local time ("the soonest
 * compliant start is 09:26"). Two clocks on one screen, and the demo's answer
 * to "when do you send somebody" was after dinner.
 */
function atLocalTime(offsetDays: number, wallClock: string): Date {
  const day = daysFrom(offsetDays).toISOString().slice(0, 10)
  return wallClockToUtc(`${day}T${wallClock}`, DEMO_ZONE)
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
  // `LedgerEntry` and `Notification` are checked below too, as of R-100c -
  // which is the third time this set has grown by exactly one item, so treat
  // the list as something to extend rather than something finished. THERE
  // ARE SIX APPEND-ONLY TABLES, NOT THE FOUR CLAUDE.md NAMES: `AuditLog`,
  // `LedgerEntry`, `Message`, `Notification`, plus `NoticeDelivery` and
  // `TenantConsent`.
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

  // R-100b added the third source, exactly as D-143 said a later item would.
  // `NoticeDelivery` is append-only too - the migration's trigger is BEFORE
  // UPDATE OR DELETE, and `NoticeDelivery.noticeId` is onDelete: Restrict -
  // so a notice that was actually SERVED can never be deleted, and neither
  // can the notice or the lease under it. Proof of service is the strongest
  // evidence this product holds; it would be strange if it were the one
  // thing a reset could erase.
  const servedPropertyIds = (
    await prisma.notice.findMany({
      where: { propertyId: { in: propertyIds }, deliveries: { some: {} } },
      select: { propertyId: true },
      distinct: ['propertyId'],
    })
  ).map((row) => row.propertyId)

  // R-100c added the fourth and fifth. `LedgerEntry` is the strongest of the
  // lot: D-11 makes it a projection of Stripe, so a demo property that has
  // ever been billed cannot be deleted without deleting money Stripe still
  // knows about - which is the reconciliation bug D-11 exists to prevent,
  // manufactured by a cleanup script.
  //
  // `Notification` is NOT redundant with it, and the case that proves it is
  // narrow enough to be worth stating: a payment FAILURE writes a
  // `payment.failed_fix` notification (R-045) and NO ledger entry at all,
  // because nothing has changed about what is owed. A tenancy whose only
  // money event was a decline is therefore notified and unbilled.
  const billedPropertyIds = (
    await prisma.ledgerEntry.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { propertyId: true },
      distinct: ['propertyId'],
    })
  ).map((row) => row.propertyId)

  const notifiedPropertyIds = (
    await prisma.notification.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { propertyId: true },
      distinct: ['propertyId'],
    })
  ).map((row) => row.propertyId!)

  const sticky = new Set([
    ...auditedPropertyIds,
    ...conversedPropertyIds,
    ...servedPropertyIds,
    ...billedPropertyIds,
    ...notifiedPropertyIds,
  ])
  const deletableProperties = propertyIds.filter((id) => !sticky.has(id))
  const stickyProperties = propertyIds.filter((id) => sticky.has(id))

  // ---- COMPLIANCE ITEMS, always deleted, on BOTH branches ----
  //
  // The only rows here that are cleaned up regardless of stickiness, and the
  // reason is that they are the only ones carrying no evidence: the seed
  // writes them uncompleted, so there is no `ComplianceCompletion`, no
  // document and no proof of anything - just a due date somebody invented.
  //
  // Scoped by ENTITY as well as by property, which is what was missing:
  // an entity-scoped item has `propertyId: null` and so matched no
  // property-keyed delete at all. Three items per run were surviving every
  // reset and the count only gave it away because it grew - 3, 6, 9 - while
  // every other number held steady. A leak that grows linearly is the one
  // kind you can still catch by looking.
  //
  // BEFORE EITHER BRANCH TOUCHES A PROPERTY, and that ordering is the whole
  // of the second bug this block had. `ComplianceItem` carries a check
  // constraint that exactly one of `propertyId`/`legalEntityId` is set, so
  // the SET NULL a property delete cascades makes the row illegal and the
  // DELETE fails - the same shape as the `JobRun` unique-key collision
  // documented further down, and it fails at the property delete rather than
  // here, which is what makes it read as an unrelated error.
  await prisma.complianceCompletion.deleteMany({
    where: {
      complianceItem: {
        OR: [{ propertyId: { in: propertyIds } }, { legalEntityId: { in: entityIds } }],
      },
    },
  })
  await prisma.complianceItem.deleteMany({
    where: { OR: [{ propertyId: { in: propertyIds } }, { legalEntityId: { in: entityIds } }] },
  })

  // ---- TASKS, also always deleted, on BOTH branches ----
  //
  // Same test as the compliance items above: a `Task` is machine bookkeeping,
  // not evidence - D-9 draws that line itself, and none of the types this
  // seed writes is in `AUDITED_TASK_TYPES`. It goes on the sticky branch too,
  // deliberately: a retired property keeps its inspections and its notices
  // because they are the record, but a task is a thing somebody is being
  // asked to DO, and "chase the vendor at a property that no longer exists"
  // is not something to leave on anybody's day.
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })

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

    // END THE RETIRED TENANCY (R-119), for exactly the reason its tenant is
    // deactivated one line above. Every other live thing under a sticky
    // property is stood down here - the vendor tokens, the listings, the
    // subscriptions - and the lease itself was the one that was not, so each
    // reset left a whole generation of leases reading ACTIVE against a
    // property nobody can reach. `rental_demo` had five of them stacked up by
    // R-118, inflating any count that reaches leases without going through
    // `currentScope`'s `property.active` filter.
    //
    // ENDED, not TERMINATED: `terminationReason` is required for the latter
    // and there was no termination - the demo was rebuilt.
    await prisma.lease.updateMany({
      where: {
        id: { in: stickyLeases.map((l) => l.id) },
        status: { in: ['ACTIVE', 'MONTH_TO_MONTH', 'DRAFT', 'PENDING_SIGNATURE'] },
      },
      data: { status: 'ENDED' },
    })

    // STOP BILLING THE RETIRED TENANCY (R-100c). Same reasoning as the
    // vendor tokens above, one rung more serious: a retired demo lease still
    // holding a live subscription goes on raising invoices against a
    // customer nobody will look at again, and every reset would add five
    // more. Against the simulator this is a log line; against a real
    // test-mode key it is the difference between a tidy account and one
    // quietly billing a dozen ghosts.
    //
    // Cancelled through the provider rather than by clearing the id, because
    // clearing it would leave the subscription running with nothing pointing
    // at it - an orphan in Stripe that our own reconciliation could no
    // longer even name.
    // UNPUBLISH THE RETIRED PROPERTY'S LISTINGS (R-100c), for the same
    // reason the vendor tokens above are revoked: it is the only row under a
    // retired property that a STRANGER can still reach. `listingForPublic`
    // is `where: { id, status: 'PUBLISHED' }` - no scope, no active check -
    // so a retired listing stays live on the public site while every
    // internal screen has correctly forgotten it, because `currentScope`
    // filters on `property.active`. That gap only opened when R-100c made
    // this property sticky; before, its listing was deleted with it.
    await prisma.listing.updateMany({
      where: { propertyId: { in: stickyProperties }, status: 'PUBLISHED' },
      data: { status: 'UNPUBLISHED' },
    })

    const retiringPayers = await prisma.leasePayer.findMany({
      where: { propertyId: { in: stickyProperties }, active: true },
      select: { id: true, stripeSubscriptionId: true },
    })
    if (retiringPayers.length > 0) {
      const { getBillingProvider } = await loadBillingPipeline()
      for (const payer of retiringPayers) {
        if (!payer.stripeSubscriptionId) continue
        await getBillingProvider()
          .cancelSubscription({ stripeSubscriptionId: payer.stripeSubscriptionId })
          .catch((error: unknown) => {
            console.warn(`Reset: could not cancel ${payer.stripeSubscriptionId}`, error)
          })
      }
      await prisma.leasePayer.updateMany({
        where: { id: { in: retiringPayers.map((payer) => payer.id) } },
        data: { active: false },
      })
    }

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

    // ---- Leasing and risk (R-100b), deepest first ----
    //
    // Notices before the cases they are filed under and before the leases
    // they name, all three of which they reference. Safe to delete outright
    // for the same reason threads are: a notice with a delivery row put its
    // property in the other branch.
    await prisma.accommodationRequest.deleteMany({
      where: { propertyId: { in: deletableProperties } },
    })
    await prisma.notice.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.violationObservation.deleteMany({
      where: { case: { propertyId: { in: deletableProperties } } },
    })
    await prisma.violationCase.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.evictionCase.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // Envelope before lease (LeaseEnvelope.leaseId is onDelete: Restrict),
    // signers before envelope.
    await prisma.leaseSigner.deleteMany({
      where: { envelope: { lease: { propertyId: { in: deletableProperties } } } },
    })
    await prisma.leaseEnvelope.deleteMany({
      where: { lease: { propertyId: { in: deletableProperties } } },
    })

    // Applicants before applications, applications and leads before
    // prospects and listings.
    await prisma.applicant.deleteMany({
      where: { application: { propertyId: { in: deletableProperties } } },
    })
    await prisma.application.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.listingLead.deleteMany({
      where: { listing: { propertyId: { in: deletableProperties } } },
    })
    await prisma.listingSyndication.deleteMany({
      where: { listing: { propertyId: { in: deletableProperties } } },
    })
    // Showings before the prospects and units they name (R-140), and the
    // access grant before the showing. `ShowingAccess` also references a
    // `SmartLock` and an `IdentityCheck`; the seed writes neither - the
    // self-showing link walks that flow itself - so anything here is what a
    // demo walk left behind, and it goes with the showing it belongs to.
    await prisma.showingAccess.deleteMany({
      where: { showing: { propertyId: { in: deletableProperties } } },
    })
    await prisma.showing.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.identityCheck.deleteMany({
      where: { prospect: { propertyId: { in: deletableProperties } } },
    })
    await prisma.prospect.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.listing.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // Unit photos. The BYTES are deliberately left on disk: they live under
    // `.data/documents`, they are placeholder tiles, and a seed script that
    // deletes files by a path it reconstructed itself is a worse bug than a
    // few stale kilobytes.
    await prisma.document.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    await prisma.inspectionItem.deleteMany({
      where: { inspection: { propertyId: { in: deletableProperties } } },
    })
    await prisma.inspection.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // Work orders before tickets (WorkOrder.ticketId) and before the
    // preventive-maintenance templates further down (WorkOrder.pmTemplateId)
    // - and the bids a job collected before the job itself (R-140).
    await prisma.workOrderBid.deleteMany({
      where: { workOrder: { propertyId: { in: deletableProperties } } },
    })
    await prisma.workOrder.deleteMany({ where: { propertyId: { in: deletableProperties } } })
    await prisma.ticket.deleteMany({ where: { propertyId: { in: deletableProperties } } })

    // Payers and their payments (R-100c), before the charges and leases they
    // name. A property reaching this branch has no `LedgerEntry` by
    // definition - that is what put the others in the sticky branch - but it
    // can still hold a payer, because provisioning writes one before any
    // money moves and a run interrupted between the two leaves exactly that.
    // `PayerAllocation` first: it references `Charge`, which goes next.
    await prisma.payerAllocation.deleteMany({
      where: { charge: { leaseId: { in: leaseIds } } },
    })
    await prisma.payment.deleteMany({ where: { leaseId: { in: leaseIds } } })
    await prisma.leasePayer.deleteMany({ where: { leaseId: { in: leaseIds } } })

    await prisma.charge.deleteMany({ where: { leaseId: { in: leaseIds } } })
    // Deposits before the leases they reference (RESTRICT), deductions
    // before the deposits - both latent gaps until R-154's renewed tenancy
    // put a deposit on a lease this branch actually reaches.
    await prisma.depositDeduction.deleteMany({
      where: { deposit: { leaseId: { in: leaseIds } } },
    })
    await prisma.deposit.deleteMany({ where: { leaseId: { in: leaseIds } } })
    await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
    // The renewal self-FK is RESTRICT, and one deleteMany's internal row
    // order is unspecified - unlink predecessors before deleting both rows.
    await prisma.lease.updateMany({
      where: { id: { in: leaseIds }, renewedFromLeaseId: { not: null } },
      data: { renewedFromLeaseId: null },
    })
    await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    // The unit's smart lock, and anything the lock recorded. Seeded for the
    // self-showing link (R-140); `LockEvent` and `TenantLockCode` are what a
    // walk of that flow writes, and both point at the lock.
    await prisma.lockEvent.deleteMany({
      where: { smartLock: { unit: { propertyId: { in: deletableProperties } } } },
    })
    await prisma.tenantLockCode.deleteMany({
      where: { smartLock: { unit: { propertyId: { in: deletableProperties } } } },
    })
    await prisma.smartLock.deleteMany({
      where: { unit: { propertyId: { in: deletableProperties } } },
    })
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
  // The message template goes unconditionally: nothing in this seed sends
  // from it, so no surviving row can be pointing at it. The CHECKLIST cannot -
  // every seeded inspection names it, and a retired property keeps its
  // inspections, so it belongs with the vendors below.
  await prisma.messageTemplate.deleteMany({ where: { name: MESSAGE_TEMPLATE_NAME } })

  if (stickyProperties.length === 0) {
    await prisma.preventiveMaintenanceTemplate.deleteMany({
      where: { name: { in: [...PM_TEMPLATE_NAMES] } },
    })
    await prisma.vendor.deleteMany({ where: { name: { in: [...VENDOR_NAMES] } } })
    await prisma.inspectionTemplate.deleteMany({ where: { name: INSPECTION_TEMPLATE_NAME } })
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
    // Renamed as well as deactivated, and `defaultForType` cleared too - that
    // column is UNIQUE, so a retired checklist still holding PERIODIC would
    // refuse the next run's own template rather than the next run's delete.
    for (const template of await prisma.inspectionTemplate.findMany({
      where: { name: INSPECTION_TEMPLATE_NAME },
      select: { id: true, name: true },
    })) {
      await prisma.inspectionTemplate.update({
        where: { id: template.id },
        data: { active: false, defaultForType: null, name: `${template.name} (retired ${stamp})` },
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
      ? `Reset: removed ${deletableProperties.length} demo propert${deletableProperties.length === 1 ? 'y' : 'ies'} and retired ${stickyProperties.length} that already carry an audit trail, a conversation or proof of service.`
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
      /// The tenancy's prior term, where this lease is a renewal successor
      /// (R-154). Seeds an ENDED predecessor lease linked via
      /// `renewedFromLeaseId`, with the `Deposit` on THIS lease and
      /// `receivedAt` at the original move-in - exactly the state the
      /// renewal cutover's `endRenewalPredecessor` writer produces, so the
      /// demo walk can see a renewed tenancy whose deposit clock works.
      renewedPriorTerm?: { startsOn: Date; endsOn: Date; rentCents: number }
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
  status: 'PENDING_APPROVAL' | 'ASSIGNED' | 'SCHEDULED' | 'IN_PROGRESS' | 'WORK_COMPLETE' | 'INVOICED'
  priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE'
  /// Index into VENDOR_NAMES. ABSENT means nobody is assigned yet, which is
  /// the only honest shape for a job still collecting bids.
  vendorIndex?: 0 | 1 | 2
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
  /// THE TENANT'S VERIFY LINK (MAINT-07, R-032c). Requires WORK_COMPLETE and
  /// a parent ticket - `seedWorkOrder` throws otherwise rather than minting a
  /// link whose page renders a rejection.
  liveVerifyLink?: boolean
  /// Vendors this job asked for a PRICE from, as indexes into VENDOR_NAMES.
  /// Each gets a `WorkOrderBid` row and its own live link, because bidding is
  /// the one flow where several vendors hold live links to one job at once.
  /// Only meaningful while the job is still open to bids - `verifyBidLink`
  /// refuses anything past APPROVED.
  bidVendorIndexes?: (0 | 1 | 2)[]
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
 * The leasing and risk story, keyed the same way as MAINTENANCE (R-100b).
 *
 * SEPARATE FROM THE MAINTENANCE MAP, not merged into it, because the two are
 * seeded at different points and depend on different things: maintenance
 * needs only a unit, while a prospect needs a listing and an envelope needs
 * a lease. Keeping them apart is what lets the leasing pass run after the
 * listing it hangs off exists, without either map having to know the other's
 * ordering.
 *
 * EVERY STATUS HERE WAS CHECKED AGAINST THE LIST THAT RENDERS IT, which is
 * R-100b's row's own warning and R-036b's lesson: a value existing in the
 * enum says nothing about the screens that read it. `demo-seed.test.ts`
 * asserts the two that actually filter - a listing must be PUBLISHED to be
 * publicly reachable, and an accommodation request must be undecided to
 * appear on the violation case beside it.
 */
interface ListingPlan {
  headline: string
  description: string
  rentCents: number
  depositCents: number
  applicationFeeCents: number
  availableInDays: number
  requirements: string
  petsAllowed: boolean
  petPolicyText: string
  /// Placeholder tiles, not photography. See `PLACEHOLDER_PHOTOS`.
  photos: number
}

interface ProspectPlan {
  firstName: string
  lastName: string
  email: string
  status: 'INQUIRY' | 'PRE_SCREENED' | 'SHOWING' | 'APPLIED' | 'SCREENED' | 'APPROVED'
  source: string
  daysAgo: number
  /// Written for anyone who got as far as applying. Below APPLIED there is
  /// no Application row, which is the point - a funnel where every prospect
  /// has an application is not a funnel.
  application?: { completed: boolean; monthlyIncomeCents: number; employer: string }
  /// A LIVE PRESCREEN LINK (LEAS-02). Only mintable while the prospect has
  /// not answered - `prescreenLinkStatus` refuses one who has, which is the
  /// correct product rule and a dead demo page.
  livePrescreenLink?: boolean
  /// A LIVE BOOKING LINK (LEAS-04). Only mintable for a prospect with NO
  /// showing yet - `showingLinkStatus` short-circuits to "already booked"
  /// otherwise, which is a rejection page rather than the slot picker.
  liveBookingLink?: boolean
  /// A booked viewing, and with `selfAccess` a live self-showing link that
  /// walks identity check -> lock code (LEAS-05). Needs the unit's smart
  /// lock, which is seeded alongside it.
  showing?: { inDays: number; selfAccess: boolean }
  /// A LIVE APPLICATION LINK (LEAS-06), for the applicant this prospect's
  /// application names as lead. Most useful on an application still being
  /// filled in - a completed one renders a finished form.
  liveApplicationLink?: boolean
}

interface EnvelopePlan {
  /// The tenant taking the unit, created here rather than promoted from a
  /// prospect: promotion is a real flow with its own screens (R-063), and a
  /// seed that half-performs it would leave a prospect in a state the real
  /// flow never produces.
  tenant: { firstName: string; lastName: string; email: string; phone: string }
  rentCents: number
  depositCents: number
  startsInDays: number
  termMonths: number
  /// PARTIALLY_SIGNED is the only interesting one: DRAFT has not gone out
  /// and COMPLETED is just a lease. Mid-envelope is the state the chase
  /// screens exist for.
  signers: {
    name: string
    role: 'TENANT' | 'GUARANTOR'
    status: 'SIGNED' | 'SENT' | 'VIEWED'
    /// A LIVE SIGNING LINK (LEAS-08). Meaningless on a SIGNED signer, whose
    /// page is a receipt - the interesting one is whoever the envelope is
    /// still waiting on.
    liveSignLink?: boolean
  }[]
}

interface NoticePlan {
  type: string
  daysAgo: number
  method: 'PERSONAL' | 'POSTED_WITH_PHOTO' | 'CERTIFIED_MAIL' | 'FIRST_CLASS_MAIL'
  bodyText: string
  /// Days the tenant has to cure, from service. What the eviction case's
  /// clock counts down, and the whole reason the demo has one.
  cureDays: number
  trackingNumber?: string
}

interface ViolationPlan {
  kind: 'UNAUTHORIZED_ANIMAL' | 'UNAUTHORIZED_OCCUPANT' | 'PREMISES_CONDITION'
  status: 'OPEN'
  summary: string
  daysAgo: number
  /// The accommodation request that arrived IN ANSWER to the violation, and
  /// the reason this pair is seeded together rather than in two places. An
  /// assistance-animal request against an unauthorized-animal case is the
  /// canonical fair-housing scenario, and the violation page has a panel for
  /// exactly the undecided ones.
  accommodation?: {
    kind: 'ASSISTANCE_ANIMAL' | 'SERVICE_ANIMAL' | 'POLICY_EXCEPTION'
    status: 'RECEIVED' | 'INFO_REQUESTED'
    requestText: string
    daysAgo: number
  }
}

interface LeasingPlan {
  listing?: ListingPlan
  prospects?: ProspectPlan[]
  envelope?: EnvelopePlan
  notice?: NoticePlan
  /// Opened at the stage the notice put it in. NOTICE, not FILING - nothing
  /// has been filed, the cure period is still running, and a demo that opens
  /// on a courthouse step misrepresents what this product is for.
  eviction?: { stage: 'NOTICE'; daysAgo: number }
  violation?: ViolationPlan
}

export const LEASING: Record<string, LeasingPlan> = {
  // THE VACANCY, END TO END: a published listing, a funnel with somebody at
  // every stage of it, and a lease already out for signature on the one who
  // got approved.
  'Magnolia Drive House::ADU': {
    listing: {
      headline: 'Detached one-bedroom garden ADU',
      description:
        'Private entrance, full kitchen, in-unit laundry, and a fenced patio. Separately metered. Walking distance to the greenbelt trailhead.',
      rentCents: 145_000,
      depositCents: 145_000,
      applicationFeeCents: 5_000,
      availableInDays: 21,
      requirements:
        'Combined household income of three times the monthly rent, verifiable through pay stubs or bank statements. No prior lease-breaking judgments.',
      petsAllowed: true,
      petPolicyText: 'One cat or dog under 40lb with a refundable pet deposit. Breed restrictions apply.',
      photos: 3,
    },
    prospects: [
      {
        firstName: 'Tomas',
        lastName: 'Almeida',
        email: 'tomas.almeida@example.test',
        status: 'INQUIRY',
        source: 'zillow',
        daysAgo: 1,
        livePrescreenLink: true,
      },
      {
        firstName: 'Grace',
        lastName: 'Whitfield',
        email: 'grace.whitfield@example.test',
        status: 'PRE_SCREENED',
        source: 'apartments.com',
        daysAgo: 4,
        liveBookingLink: true,
      },
      {
        firstName: 'Elias',
        lastName: 'Boateng',
        email: 'elias.boateng@example.test',
        status: 'SHOWING',
        source: 'zillow',
        daysAgo: 6,
        showing: { inDays: 2, selfAccess: true },
      },
      {
        firstName: 'Nadia',
        lastName: 'Fournier',
        email: 'nadia.fournier@example.test',
        status: 'APPLIED',
        source: 'referral',
        daysAgo: 9,
        application: { completed: true, monthlyIncomeCents: 616_000, employer: 'St. David\u2019s Medical Center' },
      },
      {
        // MID-APPLICATION. Every other application here is complete, which
        // makes the one screen the applicant actually uses - the form, the
        // co-applicant invite, the document upload, the fee - unreachable
        // from the demo. Started, not finished, is the state that link is
        // for.
        firstName: 'Priya',
        lastName: 'Raghunathan',
        email: 'priya.raghunathan@example.test',
        status: 'APPLIED',
        source: 'zillow',
        daysAgo: 2,
        application: { completed: false, monthlyIncomeCents: 559_000, employer: 'Silverline Logistics' },
        liveApplicationLink: true,
      },
      {
        firstName: 'Reuben',
        lastName: 'Castillo',
        email: 'reuben.castillo@example.test',
        status: 'SCREENED',
        source: 'apartments.com',
        daysAgo: 12,
        application: { completed: true, monthlyIncomeCents: 508_000, employer: 'Travis County Schools' },
      },
      {
        firstName: 'Imani',
        lastName: 'Oyelaran',
        email: 'imani.oyelaran@example.test',
        status: 'APPROVED',
        source: 'zillow',
        daysAgo: 16,
        application: { completed: true, monthlyIncomeCents: 733_000, employer: 'Osprey Analytics' },
      },
    ],
    envelope: {
      tenant: {
        firstName: 'Imani',
        lastName: 'Oyelaran',
        email: 'imani.oyelaran@example.test',
        phone: '+15125550188',
      },
      rentCents: 145_000,
      depositCents: 145_000,
      startsInDays: 21,
      termMonths: 12,
      // One signed, one still out - which is exactly what PARTIALLY_SIGNED
      // means and the only state where the chase has anything to chase.
      signers: [
        { name: 'Imani Oyelaran', role: 'TENANT', status: 'SIGNED' },
        { name: 'Adaeze Oyelaran', role: 'GUARANTOR', status: 'VIEWED', liveSignLink: true },
      ],
    },
  },

  // THE TENANT WHO IS BEHIND. `buildPlan()` already gives this unit the
  // 'late' lifecycle and an overdue rent charge, so the notice and the case
  // land on somebody the rest of the demo already shows as late - rather
  // than on a tenant who looks current everywhere else.
  'Riverside Court Duplex::Unit A': {
    notice: {
      type: 'NOTICE_TO_VACATE',
      daysAgo: 3,
      method: 'PERSONAL',
      bodyText:
        'You are hereby given notice to vacate the premises for non-payment of rent. You may avoid further action by paying the full amount past due within the period stated below. This notice is a draft prepared by the property manager and is not legal advice.',
      cureDays: 3,
    },
    eviction: { stage: 'NOTICE', daysAgo: 3 },
  },

  // THE FAIR-HOUSING PAIR, and the most instructive thing in the seed. An
  // unauthorized-animal case answered by an assistance-animal request that
  // nobody has decided yet - which is precisely when the decision is still
  // being made correctly or incorrectly, and precisely what the undecided
  // panel on the violation page is for.
  'Sunset Boulevard Townhouse::Main unit': {
    violation: {
      kind: 'UNAUTHORIZED_ANIMAL',
      status: 'OPEN',
      summary: 'A dog was observed in the unit during a scheduled drain repair. No pet is on the lease.',
      daysAgo: 5,
      accommodation: {
        kind: 'ASSISTANCE_ANIMAL',
        status: 'RECEIVED',
        requestText:
          'The dog is an emotional support animal prescribed by my therapist. I am requesting an exception to the no-pet term of my lease. I can provide a letter.',
        daysAgo: 2,
      },
    },
  },
}

/**
 * Compliance items, which hang off a property or a legal entity rather than
 * a unit - so they are a flat list rather than another keyed map.
 *
 * ONE OVERDUE AND ONE DUE SOON, deliberately. A compliance screen where
 * everything is green demonstrates nothing, and one where everything is red
 * looks like a broken seed rather than a portfolio.
 */
export const COMPLIANCE: {
  type: string
  label: string
  dueInDays: number
  scope: 'PROPERTY' | 'ENTITY'
  propertyName?: string
  entityIndex?: 0 | 1
}[] = [
  {
    type: 'SMOKE_ALARM_INSPECTION',
    label: 'Annual smoke and CO alarm certification',
    dueInDays: -11,
    scope: 'PROPERTY',
    propertyName: 'Riverside Court Duplex',
  },
  {
    type: 'POOL_PERMIT',
    label: 'City pool enclosure permit renewal',
    dueInDays: 19,
    scope: 'PROPERTY',
    propertyName: 'Magnolia Drive House',
  },
  {
    type: 'ENTITY_FRANCHISE_TAX',
    label: 'Texas franchise tax report',
    dueInDays: 46,
    scope: 'ENTITY',
    entityIndex: 0,
  },
]

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
    // A JOB THE VENDOR SAYS IS DONE AND THE TENANT HAS NOT CONFIRMED
    // (MAINT-07, R-032c). WORK_COMPLETE is not the end of the loop - the
    // tenant answers "was this fixed?" from a link, and answering no reopens
    // it. Until R-140 the demo had no work order in this state attached to a
    // ticket, so the verify page was unreachable and the reopen path with it.
    tickets: [
      {
        category: 'Appliance',
        description: 'Garbage disposal hums but will not turn. Nothing stuck in it that I can see.',
        priority: 'ROUTINE',
        status: 'CONVERTED',
        source: 'PORTAL',
        daysAgo: 6,
        respondedAfterMinutes: 55,
        conversation: [
          {
            from: 'TENANT',
            body: 'Garbage disposal hums but will not turn. Nothing stuck in it that I can see.',
            minutesAfter: 0,
          },
          {
            from: 'STAFF',
            body: 'Sending Rivera out Tuesday morning. We will text you to confirm once they mark it done.',
            minutesAfter: 55,
          },
        ],
        workOrder: {
          scope: 'Free or replace seized garbage disposal in the kitchen.',
          status: 'WORK_COMPLETE',
          priority: 'ROUTINE',
          vendorIndex: 0,
          estimateCents: 24_000,
          approvedAmountCents: 24_000,
          scheduledInDays: -2,
          vendorResponse: 'ACCEPTED',
          liveVerifyLink: true,
          vendorConversation: [
            {
              from: 'VENDOR',
              body: 'Motor was seized. Swapped the unit, ran it ten minutes, draining clean. Photos attached.',
              minutesAfter: 320,
            },
          ],
        },
      },
    ],
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
        // WHY THE UNIT IS DOWN, and the only job here still collecting
        // prices (MAINT-04, R-026). PENDING_APPROVAL names no vendor on
        // purpose - nobody has been chosen - and each bidder holds their own
        // live link at the same time, which is the whole reason VENDOR_BID
        // is a separate purpose from the dispatch link.
        scope: 'Replace failed water heater and repair water-damaged subfloor in the utility closet.',
        status: 'PENDING_APPROVAL',
        priority: 'URGENT',
        estimateCents: 340_000,
        bidVendorIndexes: [0, 2],
      },
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
      timezone: DEMO_ZONE,
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
              renewedPriorTerm: { startsOn: daysFrom(-605), endsOn: daysFrom(-240), rentCents: 210000 },
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
      timezone: DEMO_ZONE,
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
      timezone: DEMO_ZONE,
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
      timezone: DEMO_ZONE,
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

/**
 * Three 1x1 PNGs in muted colours, written as unit photos.
 *
 * ponytail: placeholder tiles, not photography - `object-cover` on a square
 * renders a 1x1 as a clean solid block, which reads as a deliberate
 * placeholder rather than a broken image. Swap for real images the day there
 * are any; nothing else has to change, because they are ordinary
 * `UNIT_PHOTO` Documents.
 *
 * Base64 constants rather than generated with `node:zlib`, because a CRC and
 * a deflate stream is more code than the thing it produces.
 */
const PLACEHOLDER_PHOTOS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
]

// Matches `generateStorageKey` and `LocalDiskStorageAdapter` in
// apps/web/lib/storage, which this script CANNOT import: that module is
// `server-only`, and a plain node script is exactly what that marker exists
// to keep out. Duplicated deliberately and narrowly - the key shape and the
// root path, nothing else - and only ever used against local disk.
//
// RESOLVED FROM THIS FILE, NEVER FROM `process.cwd()`, and that is the whole
// bug Milestone 11's demo walk found. `LocalDiskStorageAdapter`'s default is
// `join(process.cwd(), '.data', 'documents')` - and the Next server's cwd is
// `apps/web` while this script is run from the repo root, so the identical
// expression names two different directories. Every demo listing photo was
// written to `<repo>/.data/documents` and read from
// `<repo>/apps/web/.data/documents`: three broken images and three logged
// exceptions on `/listings/[id]`, the one page in this product a prospective
// renter sees. `e2e/portal.spec.ts` carries a comment about hitting exactly
// this - "a 500 that looked like an authorization failure until both `.data`
// directories turned up on disk" - and this file reintroduced it, so the fix
// here does not depend on where it is run from at all.
const DOCUMENT_ROOT =
  process.env.DOCUMENT_STORAGE_PATH ??
  fileURLToPath(new URL('../../../apps/web/.data/documents', import.meta.url))

/// True when uploads go to Vercel Blob rather than local disk. Photos are
/// SKIPPED rather than seeded in that case: rows whose bytes do not exist
/// render as broken images, which is worse than a listing with none, and
/// this script has no business writing to a shared blob store.
const storageIsRemote = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())

async function writeUnitPhoto(
  propertyId: string,
  unitId: string,
  index: number,
): Promise<boolean> {
  if (storageIsRemote) return false
  const bytes = Buffer.from(PLACEHOLDER_PHOTOS[index % PLACEHOLDER_PHOTOS.length]!, 'base64')
  const fileName = `demo-photo-${index + 1}.png`
  const storageKey = `${propertyId}/${randomUUID()}-${fileName}`
  const path = resolve(DOCUMENT_ROOT, storageKey)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)

  await prisma.document.create({
    data: {
      propertyId,
      unitId,
      type: 'UNIT_PHOTO',
      fileName,
      contentType: 'image/png',
      sizeBytes: bytes.byteLength,
      storageKey,
      capturedAt: daysFrom(-30 + index),
    },
  })
  return true
}

/**
 * WHERE EVERY STRANGER-REACHABLE LINK POINTS, keyed by the token purpose that
 * opens it.
 *
 * ==========================================================================
 * THIS TABLE IS THE ITEM. Until R-140 the seed minted exactly ONE live token
 * - a vendor dispatch link - so eight routes a stranger can reach held no
 * demo state anyone could open: the prescreen, the application, the lease
 * signature, the pay link, the tenant's "was this fixed?", the bid request,
 * the showing booking, the self-showing access code and the calendar feed.
 * D-28 requires a browser walk when a milestone closes, and a walk cannot
 * reach a page whose only door needs a token nothing prints.
 *
 * Keyed by purpose rather than a free string at each call site so that a new
 * `AuthTokenPurpose` cannot be minted here without somebody deciding, in one
 * place, where its link points.
 * ==========================================================================
 */
export const STRANGER_ROUTES = {
  VENDOR_WORK_ORDER: '/vendor/',
  VENDOR_BID: '/vendor/bid/',
  TENANT_VERIFY: '/verify/',
  TENANT_PAY_LINK: '/pay/',
  PROSPECT_PRESCREEN: '/prescreen/',
  APPLICATION_LINK: '/apply/',
  LEASE_SIGN: '/sign/',
  SHOWING_BOOKING: '/showings/',
  SHOWING_ACCESS: '/showings/access/',
  CALENDAR_FEED: '/api/calendar/',
} as const

type StrangerPurpose = keyof typeof STRANGER_ROUTES

/// One printed link. `who` is the person holding it, because a demo walk is
/// performed as somebody - opening the bid link as "Rivera Plumbing" is a
/// different act from opening it as "a vendor".
interface DemoLink {
  who: string
  what: string
  url: string
}

/**
 * Mints one live token and records the link to print at the end of the run.
 *
 * The same purpose, subject and metadata shape the product's own issuer
 * writes, minted here rather than by calling it: every issuer lives in
 * `apps/web` and this script is in `packages/db`. `mintToken` is core, which
 * both can reach - so the token itself comes from the one function that
 * produces every other token in the product, and only the row around it is
 * written twice. That is the rule R-100a set for the vendor link and this
 * generalizes it rather than adding a second way.
 *
 * METADATA IS NOT OPTIONAL DECORATION on three of these. `TENANT_VERIFY`
 * refuses a link whose `tenantId` is not still the ticket's tenant,
 * `TENANT_PAY_LINK` records the tenant and lease so a payer row edited
 * afterwards cannot silently move who the link belongs to, and `VENDOR_BID`
 * carries the vendor whose bid it authorizes. A link minted without them
 * renders a rejection page, which looks exactly like a broken demo.
 */
async function mintDemoLink(
  purpose: StrangerPurpose,
  subject: { type: string; id: string },
  link: { who: string; what: string },
  sink: DemoLink[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  const minted = mintToken(purpose)
  await prisma.authToken.create({
    data: {
      purpose,
      tokenHash: minted.tokenHash,
      subjectType: subject.type,
      subjectId: subject.id,
      expiresAt: minted.expiresAt,
      ...(metadata ? { metadata: metadata as never } : {}),
    },
  })
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3100'
  sink.push({ ...link, url: `${base}${STRANGER_ROUTES[purpose]}${minted.token}` })
}

interface SeedContext {
  propertyId: string
  addressOfRecord: string
  unitId: string
  leaseId: string | null
  tenantId: string | null
  staffId: string
  vendorRows: { id: string; name: string }[]
  pmTemplateRows: { id: string }[]
  /// The reusable checklist every seeded inspection was walked from. Null is
  /// a legal value on `Inspection.templateId` - a one-off walk needs no
  /// template - but a demo where every inspection is a one-off never shows
  /// what a checklist is for.
  inspectionTemplateId: string
  demoLinks: DemoLink[]
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
  // A JOB STILL COLLECTING BIDS NAMES NO VENDOR. Nobody has been chosen yet,
  // so `vendorId` and `dispatchedAt` are both null - a PENDING_APPROVAL work
  // order already pointing at a vendor is two facts about the same job
  // disagreeing on screen. Everything past that has been dispatched to
  // somebody, which is what ASSIGNED means, so the timestamp is derived from
  // the state rather than carried in the plan where it could drift from it.
  const vendor = plan.vendorIndex == null ? null : context.vendorRows[plan.vendorIndex]!
  const dispatchedAt = vendor == null ? null : daysFrom(plan.status === 'ASSIGNED' ? -1 : -4)

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: context.propertyId,
      unitId: context.unitId,
      ticketId: context.ticketId,
      vendorId: vendor?.id ?? null,
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
      // A 9am-to-noon window on the property's own clock, not UTC midnight.
      scheduledStart:
        plan.scheduledInDays == null ? null : atLocalTime(plan.scheduledInDays, '09:00'),
      scheduledEnd:
        plan.scheduledInDays == null
          ? null
          : minutesFrom(atLocalTime(plan.scheduledInDays, '09:00'), 3 * 60),
      invoiceCents: plan.invoiceCents ?? null,
      pmTemplateId:
        plan.pmTemplateIndex == null ? null : context.pmTemplateRows[plan.pmTemplateIndex]!.id,
    },
  })

  if (plan.liveVendorLink) {
    if (!vendor) {
      throw new Error(
        `liveVendorLink on a work order with no vendor (${plan.scope}). A dispatch ` +
          'link is scoped to whoever the job names, so there is nobody to scope it to.',
      )
    }
    await mintDemoLink(
      'VENDOR_WORK_ORDER',
      { type: 'WorkOrder', id: workOrder.id },
      { who: vendor.name, what: `Vendor work order - ${plan.scope}` },
      context.demoLinks,
      // What `vendorLinkAccess()` compares against whoever the work order
      // currently names - the check that stops a reassigned vendor's
      // un-expired link still opening a gate code.
      { vendorId: vendor.id },
    )
  }

  // THE TENANT'S "was this fixed?" (MAINT-07, R-032c). Only mintable on a job
  // that is WORK_COMPLETE and hangs off a TICKET: `verifyVerifyLink` refuses
  // a link whose recorded tenant is not still the ticket's tenant, and a
  // standalone work order has no ticket and therefore no tenant at all.
  if (plan.liveVerifyLink) {
    if (!context.ticketId || !context.tenantId) {
      throw new Error(
        `liveVerifyLink on a work order with no ticket or no tenant (${plan.scope}). ` +
          'The verify link is answerable only by the tenant who raised the ticket.',
      )
    }
    await mintDemoLink(
      'TENANT_VERIFY',
      { type: 'WorkOrder', id: workOrder.id },
      {
        who: `the tenant at ${context.addressOfRecord}`,
        what: `Was this fixed? - ${plan.scope}`,
      },
      context.demoLinks,
      // The round is the token's question, not the job's current one - see
      // `verifyVerifyLink`. A fresh job has never been reopened, so it is 1.
      { tenantId: context.tenantId, round: workOrder.reopenCount + 1 },
    )
  }

  // A PRICE REQUEST, before anybody is assigned (MAINT-04, R-026). N vendors
  // hold live links to the same job at once, which is the whole reason
  // VENDOR_BID is a separate purpose from the dispatch link - so the demo
  // seeds every requested bid and prints a link for each.
  for (const bidIndex of plan.bidVendorIndexes ?? []) {
    const bidder = context.vendorRows[bidIndex]!
    await prisma.workOrderBid.create({
      data: {
        workOrderId: workOrder.id,
        vendorId: bidder.id,
        requestedAt: daysFrom(-2),
      },
    })
    await mintDemoLink(
      'VENDOR_BID',
      { type: 'WorkOrder', id: workOrder.id },
      { who: bidder.name, what: `Bid request - ${plan.scope}` },
      context.demoLinks,
      { vendorId: bidder.id },
    )
  }

  let messages = 0
  for (const line of vendor == null ? [] : (plan.vendorConversation ?? [])) {
    const thread = await threadFor(
      {
        scope: 'VENDOR',
        propertyId: context.propertyId,
        vendorId: vendor!.id,
        workOrderId: workOrder.id,
      },
      { workOrderId: workOrder.id, ticketId: context.ticketId },
    )
    await writeMessage({
      threadId: thread.id,
      channel: 'SMS',
      direction: line.from === 'VENDOR' ? 'INBOUND' : 'OUTBOUND',
      body: line.body,
      sentAt: minutesFrom(dispatchedAt!, line.minutesAfter),
      staffUserId: line.from === 'STAFF' ? context.staffId : null,
      vendorId: line.from === 'VENDOR' ? vendor!.id : null,
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
      templateId: context.inspectionTemplateId,
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

/**
 * The staff work queue (D-9), derived rather than written down.
 *
 * `/tasks` - "My day", the screen a PM opens first - was the emptiest screen
 * in the whole demo when the Milestone 10 walk went looking: zero tasks, a
 * portfolio roll-up of six properties by three columns of zeroes, and the one
 * queue this product deliberately has only one of.
 *
 * DERIVED FROM WHAT THE OTHER STORIES ALREADY BUILT, never a fourth hand-
 * written map. A task is a thing somebody has to DO about a row that exists,
 * so inventing them beside the rows would let the two drift - a task naming a
 * work order the maintenance story stopped seeding is exactly the kind of
 * demo bug nobody finds until they are standing in front of somebody.
 *
 * Written with `prisma.task.create` rather than through `createTask()`, which
 * is `server-only` and behind the same wall as the billing pipeline. The one
 * thing that helper does which matters here is the date: `businessDate` is
 * `@db.Date`, and `daysFrom()` already returns UTC midnight, which is what a
 * calendar day has to be in that column (never a zone-converted instant).
 */
async function seedTasks(staffId: string, propertyIds: readonly string[]): Promise<number> {
  const rows: {
    propertyId: string
    type: string
    subjectType: string
    subjectId: string
    businessDate: Date
    priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE'
    title: string
  }[] = []

  const workOrders = await prisma.workOrder.findMany({
    where: { propertyId: { in: [...propertyIds] } },
    select: { id: true, propertyId: true, status: true, priority: true, scope: true },
  })
  for (const workOrder of workOrders) {
    // A short subject line, because `Task.title` is read in a list of a dozen
    // and a work order's `scope` is a paragraph of instructions to a vendor.
    const what = workOrder.scope.split(/[;.]/)[0]!.trim().slice(0, 60)
    if (workOrder.status === 'ASSIGNED') {
      rows.push({
        propertyId: workOrder.propertyId,
        type: 'workorder_schedule',
        subjectType: 'WorkOrder',
        subjectId: workOrder.id,
        businessDate: daysFrom(0),
        priority: workOrder.priority,
        title: `Book a time with the vendor: ${what}`,
      })
    }
    if (workOrder.status === 'WORK_COMPLETE') {
      // Overdue on purpose. A queue with nothing late in it does not show
      // what the overdue column is for, and this is the one screen where that
      // column is the whole point.
      rows.push({
        propertyId: workOrder.propertyId,
        type: 'workorder_ready_to_close',
        subjectType: 'WorkOrder',
        subjectId: workOrder.id,
        businessDate: daysFrom(-2),
        priority: 'ROUTINE',
        title: `Verify and close: ${what}`,
      })
    }
  }

  for (const inspection of await prisma.inspection.findMany({
    where: { propertyId: { in: [...propertyIds] }, performedAt: null },
    select: { id: true, propertyId: true, type: true, scheduledFor: true },
  })) {
    rows.push({
      propertyId: inspection.propertyId,
      type: `inspection.${inspection.type.toLowerCase()}_scheduled`,
      subjectType: 'Inspection',
      subjectId: inspection.id,
      // `scheduledFor` is nullable - an inspection can be raised before a
      // date is agreed - and an undated one is due now, not never.
      businessDate: inspection.scheduledFor ?? daysFrom(0),
      priority: 'ROUTINE',
      title: 'Walk the pre-move-out inspection',
    })
  }

  // Renewal decisions, for the leases the dashboard is already counting as
  // expiring. 90 days matches the dashboard tile, so the queue and the tile
  // are talking about the same leases rather than two different windows.
  for (const lease of await prisma.lease.findMany({
    where: {
      propertyId: { in: [...propertyIds] },
      status: 'ACTIVE',
      noticeGivenAt: null,
      endsOn: { lte: daysFrom(90) },
    },
    select: { id: true, propertyId: true, endsOn: true },
  })) {
    // `lte` above already excludes the nulls a month-to-month tenancy has -
    // there is no term to renew - but the column is nullable and TypeScript
    // is right to ask.
    if (!lease.endsOn) continue
    rows.push({
      propertyId: lease.propertyId,
      type: 'lease_renewal',
      subjectType: 'Lease',
      subjectId: lease.id,
      // Sixty days before the term ends, which for these leases is already
      // behind us - a renewal nobody has decided on IS late by then.
      businessDate: new Date(lease.endsOn.getTime() - 60 * 86_400_000),
      priority: 'ROUTINE',
      title: 'Decide whether to offer a renewal',
    })
  }

  for (const row of rows) {
    await prisma.task.create({ data: { ...row, assigneeStaffId: staffId } })
  }
  return rows.length
}

/**
 * The leasing and risk story for one unit.
 *
 * Ordered so nothing points at a row that does not exist yet: listing, then
 * the prospects on it, then the lease and envelope, then the notice and the
 * case that files it, then the violation and the request answering it.
 */
async function seedLeasing(
  plan: LeasingPlan,
  context: SeedContext & { propertyName: string; unitName: string },
): Promise<{ photos: number; prospects: number; cases: number }> {
  let photos = 0
  let prospects = 0
  let cases = 0

  let listingId: string | null = null
  if (plan.listing) {
    const listing = await prisma.listing.create({
      data: {
        propertyId: context.propertyId,
        unitId: context.unitId,
        // PUBLISHED, and it is the one status that matters here: the public
        // listing page filters on it outright, so a DRAFT listing is a demo
        // page that 404s.
        status: 'PUBLISHED',
        headline: plan.listing.headline,
        description: plan.listing.description,
        rentCents: plan.listing.rentCents,
        depositCents: plan.listing.depositCents,
        applicationFeeCents: plan.listing.applicationFeeCents,
        availableOn: daysFrom(plan.listing.availableInDays),
        requirements: plan.listing.requirements,
        petsAllowed: plan.listing.petsAllowed,
        petPolicyText: plan.listing.petPolicyText,
        publishedAt: daysFrom(-24),
        createdByStaffId: context.staffId,
      },
    })
    listingId = listing.id

    for (let index = 0; index < plan.listing.photos; index++) {
      if (await writeUnitPhoto(context.propertyId, context.unitId, index)) photos++
    }
  }

  if (listingId) {
    for (const prospectPlan of plan.prospects ?? []) {
      const enquiredAt = daysFrom(-prospectPlan.daysAgo)
      const prospect = await prisma.prospect.create({
        data: {
          propertyId: context.propertyId,
          listingId,
          firstName: prospectPlan.firstName,
          lastName: prospectPlan.lastName,
          email: prospectPlan.email,
          status: prospectPlan.status,
          source: prospectPlan.source,
          createdAt: enquiredAt,
        },
      })
      prospects++

      if (prospectPlan.livePrescreenLink) {
        await mintDemoLink(
          'PROSPECT_PRESCREEN',
          { type: 'Prospect', id: prospect.id },
          {
            who: `${prospectPlan.firstName} ${prospectPlan.lastName} (prospect)`,
            what: `Pre-screen questions - ${context.addressOfRecord}`,
          },
          context.demoLinks,
        )
      }

      if (prospectPlan.liveBookingLink) {
        await mintDemoLink(
          'SHOWING_BOOKING',
          { type: 'Prospect', id: prospect.id },
          {
            who: `${prospectPlan.firstName} ${prospectPlan.lastName} (prospect)`,
            what: `Book a viewing - ${context.addressOfRecord}`,
          },
          context.demoLinks,
        )
      }

      if (prospectPlan.showing) {
        // The lock is the unit's, not the showing's, and `showingAccessLinkStatus`
        // reads it through the unit - so a self-showing link on a unit with no
        // lock renders a page that can never produce a code.
        if (prospectPlan.showing.selfAccess) {
          await prisma.smartLock.upsert({
            where: { unitId: context.unitId },
            update: {},
            create: {
              unitId: context.unitId,
              externalId: `demo-lock-${context.unitId}`,
              label: 'Front door keypad',
            },
          })
        }
        const start = atLocalTime(prospectPlan.showing.inDays, '17:30')
        const showing = await prisma.showing.create({
          data: {
            propertyId: context.propertyId,
            unitId: context.unitId,
            prospectId: prospect.id,
            scheduledStart: start,
            scheduledEnd: minutesFrom(start, 30),
            status: 'BOOKED',
          },
        })
        if (prospectPlan.showing.selfAccess) {
          await mintDemoLink(
            'SHOWING_ACCESS',
            { type: 'Showing', id: showing.id },
            {
              who: `${prospectPlan.firstName} ${prospectPlan.lastName} (prospect)`,
              what: `Self-showing access - ${context.addressOfRecord}`,
            },
            context.demoLinks,
          )
        }
      }

      if (!prospectPlan.application) continue
      const application = await prisma.application.create({
        data: {
          propertyId: context.propertyId,
          listingId,
          prospectId: prospect.id,
          completedAt: prospectPlan.application.completed ? daysFrom(-prospectPlan.daysAgo + 1) : null,
          createdAt: enquiredAt,
        },
      })
      const applicant = await prisma.applicant.create({
        data: {
          applicationId: application.id,
          firstName: prospectPlan.firstName,
          lastName: prospectPlan.lastName,
          email: prospectPlan.email,
          // The person staff invited, as opposed to a co-applicant they
          // added themselves - which is what gives them the application's
          // own link rather than one subject-typed to a co-applicant.
          isLead: true,
          employerName: prospectPlan.application.employer,
          monthlyIncomeCents: prospectPlan.application.monthlyIncomeCents,
          formSubmittedAt: daysFrom(-prospectPlan.daysAgo + 1),
          completedAt: prospectPlan.application.completed
            ? daysFrom(-prospectPlan.daysAgo + 1)
            : null,
        },
      })

      if (prospectPlan.liveApplicationLink) {
        await mintDemoLink(
          'APPLICATION_LINK',
          { type: 'Applicant', id: applicant.id },
          {
            who: `${prospectPlan.firstName} ${prospectPlan.lastName} (applicant)`,
            what: `Rental application - ${context.addressOfRecord}`,
          },
          context.demoLinks,
        )
      }
    }
  }

  if (plan.envelope) {
    // THE DATABASE INSISTS, and it is right to: a `LeaseEnvelope` of kind
    // LEASE has a check constraint requiring a template
    // (`LeaseEnvelope_lease_kind_needs_template`), because an envelope is a
    // document somebody signs and a document with no template behind it is
    // an envelope wrapping nothing. Found rather than created here for the
    // same reason staff are - `db:seed:lease-templates` owns the wording,
    // and a demo seed inventing lease text is a demo seed with an opinion
    // about a legal document.
    const template = await prisma.documentTemplate.findFirst({
      where: { documentType: 'LEASE', addendumKey: null, state: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!template) {
      throw new Error(
        'No lease template exists, so the e-signature envelope cannot be seeded.\n' +
          'Run `npm run db:seed:lease-templates` first, then this again.',
      )
    }

    const tenant = await prisma.tenant.create({
      data: {
        firstName: plan.envelope.tenant.firstName,
        lastName: plan.envelope.tenant.lastName,
        email: plan.envelope.tenant.email,
        phone: plan.envelope.tenant.phone,
        notes: 'Demo tenant - lifecycle state: signing.',
      },
    })
    const startsOn = daysFrom(plan.envelope.startsInDays)
    const endsOn = daysFrom(plan.envelope.startsInDays + plan.envelope.termMonths * 30)
    const lease = await prisma.lease.create({
      data: {
        propertyId: context.propertyId,
        unitId: context.unitId,
        // PENDING_SIGNATURE, not DRAFT: the envelope has gone out, and a
        // lease that says draft beside a partially-signed envelope is two
        // screens disagreeing about the same tenancy.
        status: 'PENDING_SIGNATURE',
        startsOn,
        endsOn,
        rentCents: plan.envelope.rentCents,
        depositCents: plan.envelope.depositCents,
      },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
    })

    const envelope = await prisma.leaseEnvelope.create({
      data: {
        leaseId: lease.id,
        kind: 'LEASE',
        templateId: template.id,
        status: 'PARTIALLY_SIGNED',
        addendumKeys: [],
        sentAt: daysFrom(-4),
      },
    })
    let order = 0
    for (const signer of plan.envelope.signers) {
      const signerRow = await prisma.leaseSigner.create({
        data: {
          envelopeId: envelope.id,
          order: order++,
          role: signer.role,
          name: signer.name,
          email: signer.role === 'TENANT' ? plan.envelope.tenant.email : null,
          status: signer.status,
          tenantId: signer.role === 'TENANT' ? tenant.id : null,
          // Every status this plan admits is past SENT, so all of them have
          // been looked at. A PENDING signer would need a null here, which
          // is why the union deliberately does not include one - a signer
          // who has not been sent the envelope is not mid-envelope.
          viewedAt: daysFrom(-3),
          signedAt: signer.status === 'SIGNED' ? daysFrom(-3) : null,
          signedName: signer.status === 'SIGNED' ? signer.name : null,
        },
      })
      if (signer.liveSignLink) {
        await mintDemoLink(
          'LEASE_SIGN',
          { type: 'LeaseSigner', id: signerRow.id },
          {
            who: `${signer.name} (${signer.role.toLowerCase()})`,
            what: `Sign the lease - ${context.addressOfRecord}`,
          },
          context.demoLinks,
        )
      }
    }
  }

  // The notice, the case that files it, and the violation all need the
  // SITTING tenancy, not the one being signed above.
  if (!context.leaseId) return { photos, prospects, cases }

  if (plan.notice) {
    const servedAt = daysFrom(-plan.notice.daysAgo)
    let evictionCaseId: string | null = null
    if (plan.eviction) {
      const evictionCase = await prisma.evictionCase.create({
        data: {
          propertyId: context.propertyId,
          unitId: context.unitId,
          leaseId: context.leaseId,
          stage: plan.eviction.stage,
          openedAt: daysFrom(-plan.eviction.daysAgo),
          openedByStaffId: context.staffId,
        },
      })
      evictionCaseId = evictionCase.id
      cases++
    }

    const notice = await prisma.notice.create({
      data: {
        propertyId: context.propertyId,
        leaseId: context.leaseId,
        evictionCaseId,
        type: plan.notice.type,
        addressOfRecord: context.addressOfRecord,
        bodyText: plan.notice.bodyText,
        generatedAt: daysFrom(-plan.notice.daysAgo - 1),
        // Denormalized from the delivery below, which is what actually
        // carries the proof. `recordService()` owns writing both in
        // production; this seed writes the same pair, in the same order.
        servedAt,
      },
    })
    await prisma.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method: plan.notice.method,
        servedAt,
        servedByStaffId: context.staffId,
        trackingNumber: plan.notice.trackingNumber ?? null,
        note: `Served in person and photographed. Cure period ends ${
          daysFrom(-plan.notice.daysAgo + plan.notice.cureDays).toISOString().slice(0, 10)
        }.`,
      },
    })
  }

  if (plan.violation) {
    const violation = await prisma.violationCase.create({
      data: {
        propertyId: context.propertyId,
        unitId: context.unitId,
        leaseId: context.leaseId,
        kind: plan.violation.kind,
        status: plan.violation.status,
        openedAt: daysFrom(-plan.violation.daysAgo),
        openedByStaffId: context.staffId,
      },
    })
    cases++

    // The narrative is an OBSERVATION, not a column on the case - which is
    // the schema saying something worth listening to: what somebody saw, on
    // a stated day, recorded by a named person, is evidence. A case carrying
    // a free-text summary and no observation is an allegation with nobody
    // behind it.
    await prisma.violationObservation.create({
      data: {
        caseId: violation.id,
        observedOn: daysFrom(-plan.violation.daysAgo),
        note: plan.violation.summary,
        recordedByStaffId: context.staffId,
      },
    })

    if (plan.violation.accommodation) {
      const request = plan.violation.accommodation
      await prisma.accommodationRequest.create({
        data: {
          propertyId: context.propertyId,
          leaseId: context.leaseId,
          violationCaseId: violation.id,
          kind: request.kind,
          // UNDECIDED, and the violation page's own panel filters to exactly
          // RECEIVED and INFO_REQUESTED - so an APPROVED or DENIED one here
          // would be a request nobody can find from the case it answers.
          status: request.status,
          requestText: request.requestText,
          receivedOn: daysFrom(-request.daysAgo),
        },
      })
    }
  }

  return { photos, prospects, cases }
}

// ==========================================================================
// THE MONEY STORY (R-100c, D-11, D-12, D-145)
//
// EVERYTHING ABOVE THIS LINE WRITES ROWS. THIS DOES NOT, AND CANNOT.
//
// D-11 makes `LedgerEntry` an append-only PROJECTION of Stripe: "a row here
// that Stripe does not know about is a reconciliation bug, not a shortcut."
// So the demo's balances, payment history, autopay state and mid-chase
// tenancy are not a seeding problem at all - they are a REPLAY problem. This
// section builds Stripe event envelopes and pushes them through
// `processStripeEvent`, the same function the live webhook route calls, and
// every ledger row, Payment row, receipt and failed-payment notice in the
// demo is produced by that pipeline rather than by an INSERT here.
//
// D-145 chose this over the cheaper alternative (a `Charge`-only demo whose
// rent roll ages from open charges and whose payment history is honestly
// empty), because the rent roll is the most demo-worthy screen in the
// product and R-038a proved the webhook path is where the surprises live.
//
// ---- WHY THIS SCRIPT NOW RUNS UNDER `tsx` (D-146) ----
//
// `processStripeEvent` lives in `apps/web/lib/billing/webhook.ts`, which
// begins `import 'server-only'` and reaches the rest of the app through the
// `@/` alias. Neither resolves outside Next's bundler - `server-only` is not
// even installed, so the failure is `Cannot find package` rather than the
// guard's own error - and plain `node` additionally cannot strip some of the
// TypeScript in the transitive graph (a constructor parameter property in
// the screening simulator is enough to stop it).
//
// D-145 left three routes open and this is route (c): a `module.registerHooks`
// resolver that maps `server-only` to the same empty stub `vitest.config.ts`
// already points it at, and `@/` to `apps/web`, with `tsx` doing the
// transform. Route (a) - POSTing signed bodies to the running app - was
// rejected for two reasons: it makes a seed script depend on a server being
// up and on `STRIPE_WEBHOOK_SECRET`, which is deliberately unset locally,
// and more importantly THE SIMULATOR IS PER-PROCESS. Customers created by
// this script live in this script's `SimulatedBillingProvider`, so an
// autopay enrolment handled inside the app would be talking to a simulator
// that has never heard of them.
//
// ---- WHAT IS REAL AND WHAT IS AUTHORED ----
//
// The CUSTOMERS AND SUBSCRIPTIONS are real: `provisionLeaseBilling` is the
// product's own provisioning path, so with `STRIPE_SECRET_KEY` set these are
// genuine test-mode objects, and without it they are the simulator's - the
// same choice every other environment makes, made the same way.
//
// The EVENTS are authored here, and they have to be. A demo needs three
// months of rent history on the day it is seeded; Stripe would take three
// months to emit it. So the envelopes below are written in Stripe's shape
// and interpreted by `interpretStripeEvent` exactly as delivered ones are.
// This is what D-145's route (a) already assumed - it says "POST signed
// event bodies", which is the same authored body with an HTTP hop in front.
// ==========================================================================

interface InvoicePlan {
  /// Finalized this many days ago. Relative like every other date in this
  /// file, so a demo seeded once still reads as current a month later.
  daysAgo: number
  /// What arrived against it, in cents, in the order it arrived. `'full'` is
  /// the whole rent in one delta; an empty array is an invoice nobody paid.
  /// A short array is a part-payment and the shortfall is what is still
  /// owed. CENTS RATHER THAN A FRACTION OF THE RENT deliberately - a
  /// fraction of a money amount is a rounding bug waiting to be found.
  paidCents: number[] | 'full'
  /// A declined attempt this many days after finalization. Writes a FAILED
  /// Payment and NO ledger movement, which is exactly what a decline is:
  /// nothing has changed about what is owed.
  declinedAfterDays?: number
  /// Carries the lease's seeded overdue `Charge` on its line metadata - the
  /// same round trip R-040 stamps going out and `chargeIdsOf` reads coming
  /// back. Without it the two money screens disagree: the balance is a sum
  /// over `LedgerEntry`, while the tenant's pay screen derives what is
  /// outstanding from a charge's OWN entries, so an unlinked charge shows
  /// as fully outstanding for ever no matter what has been paid.
  carriesOverdueCharge?: boolean
}

interface MoneyPlan {
  invoices: InvoicePlan[]
  /// A saved payment method, this many days ago (R-039a). Arrives as
  /// `setup_intent.succeeded`, moves no money, and is the only thing that
  /// makes autopay possible - so a demo without one shows the enrolment
  /// prompt on every tenancy.
  autopayDaysAgo?: number
  /// D-29: collection is per payer, not per product. The subscription is
  /// CREATED on this method, which is why the payer row exists before
  /// provisioning rather than being switched afterwards - switching is
  /// R-047's guarded flow and a seed half-performing it would leave a payer
  /// in a state the real flow never produces.
  collectionMethod?: 'send_invoice'
  /// An ACH debit still in flight: a PENDING Payment and no ledger movement
  /// at all. PAY-02's whole point - money in flight is not money received,
  /// and crediting it early is how a tenant is told they are square days
  /// before the return comes back.
  inFlight?: { daysAgo: number; amountCents: number }
}

/**
 * The money story per tenant, keyed by the lifecycle already on the plan.
 *
 * KEYED BY LIFECYCLE RATHER THAN BY UNIT, unlike `MAINTENANCE` and
 * `LEASING`. Those two hang off a place; this hangs off a TENANCY, and
 * `lifecycle` is the word `buildPlan()` already uses for what kind of
 * tenancy each one is. A second key saying the same thing is a second thing
 * to keep in sync.
 *
 * Between them these five cover every path the pipeline has: rent posted and
 * paid, rent posted and not paid, a part-payment, a decline, an ACH still in
 * flight, and an autopay enrolment. A demo where every tenancy is square
 * demonstrates nothing.
 */
/**
 * Days back to the 1st of THIS calendar month, so the newest rent invoice in
 * every plan lands inside the month the dashboard is reporting on.
 *
 * ==========================================================================
 * FOUND ON MILESTONE 11'S DEMO WALK, and it was structural rather than
 * stale. Every plan's newest invoice was `daysAgo: 20`-`30`, so the most
 * recent rent this seed had ever billed was always about a month back - and
 * `collectedVsBilled` on the owner's landing screen is a CALENDAR-MONTH tile
 * whose billed side is the sum of `rentCents` across live leases, by design
 * (D-11/D-40: a subscription mints no monthly `Charge` row). The two never
 * met. On 27 August the first screen of any demo read **"Collected vs billed
 * $600.00 / $9,400.00"** - a portfolio that has collected 6% of its rent -
 * while the rent roll one click away said only $1,850 was outstanding and
 * three of five tenants were current. Both numbers were right; together they
 * described a business in collapse that did not exist.
 *
 * FLOORED AT 8 DAYS so the stories that hang off the newest invoice still
 * fit inside it: a decline lands `declinedAfterDays` later and the
 * part-payment's second instalment `+7`, and neither may be dated in the
 * future. Seeded in the first week of a month, the newest invoice is last
 * month's - which is the truth about a portfolio in the first week of a
 * month, not a workaround.
 * ==========================================================================
 */
const SINCE_MONTH_START = Math.max(new Date().getUTCDate() - 1, 8)

export const MONEY: Record<string, MoneyPlan> = {
  /// Square, on autopay, three months of clean history. The contrast
  /// everything else is read against.
  current: {
    invoices: [
      { daysAgo: 90, paidCents: 'full' },
      { daysAgo: 60, paidCents: 'full' },
      { daysAgo: SINCE_MONTH_START, paidCents: 'full' },
    ],
    autopayDaysAgo: 75,
  },

  /// MID-CHASE, and the one tenancy the rest of the demo already agrees is
  /// late - R-100b hung its notice and its eviction case here for the same
  /// reason. Two clean months, then an invoice that was declined and never
  /// paid, carrying the overdue `Charge` the plan already seeds.
  late: {
    invoices: [
      { daysAgo: 90, paidCents: 'full' },
      { daysAgo: 60, paidCents: 'full' },
      {
        daysAgo: SINCE_MONTH_START,
        paidCents: [],
        declinedAfterDays: 5,
        carriesOverdueCharge: true,
      },
    ],
  },

  /// A PART-PAYMENT, which is the reason `invoice.updated` is the event this
  /// pipeline subscribes to at all (D-141): `amount_paid` is cumulative, so
  /// only a delta can be projected. Two instalments against $1,600 leaving
  /// $200 owed - and on `send_invoice`, because Stripe cannot do autopay and
  /// part-payments on one subscription (D-29).
  'in-notice': {
    invoices: [
      { daysAgo: 90, paidCents: 'full' },
      { daysAgo: 60, paidCents: 'full' },
      { daysAgo: SINCE_MONTH_START, paidCents: [80_000, 60_000] },
    ],
    collectionMethod: 'send_invoice',
  },

  /// AN ACH DEBIT STILL IN FLIGHT. Three to five days, and until it settles
  /// the balance must not move.
  'moving-out': {
    invoices: [
      { daysAgo: 90, paidCents: 'full' },
      { daysAgo: 60, paidCents: 'full' },
      { daysAgo: SINCE_MONTH_START, paidCents: 'full' },
    ],
    inFlight: { daysAgo: 2, amountCents: 195_000 },
  },

  /// A CARD DECLINED, THEN PAID. The path R-045 built `payment.failed_fix`
  /// for - before it, a tenant whose autopay card was simply declined heard
  /// about it from a phone call, if at all.
  'inherited-at-acquisition': {
    invoices: [
      { daysAgo: 90, paidCents: 'full' },
      { daysAgo: 60, paidCents: 'full' },
      { daysAgo: SINCE_MONTH_START, paidCents: 'full', declinedAfterDays: 3 },
    ],
  },
}

/// One tenancy the money story attaches to, collected while the leases are
/// being written and spent afterwards - the overdue `Charge` has to exist
/// before the invoice that carries its id.
interface MoneyTarget {
  leaseId: string
  propertyId: string
  tenantId: string
  lifecycle: string
  rentCents: number
  overdueChargeId: string | null
  /// For the printed pay link's label. A demo link that says only "pay" is
  /// unwalkable when six tenancies exist.
  addressOfRecord: string
}

/**
 * The app's billing modules, reached through a resolver. See the header
 * above for why this cannot be a plain import.
 *
 * Memoised, and lazy: `demo-seed.test.ts` imports `MONEY` and `buildPlan()`
 * from this file, and neither should drag in the entire app - or register a
 * module hook - as a side effect.
 */
let billingPipeline: Promise<{
  provisionLeaseBilling: (leaseId: string) => Promise<{
    outcome: string
    stripeCustomerId?: string
    error?: string
  }>
  processStripeEvent: (
    event: StripeEventEnvelope,
  ) => Promise<{ outcome: string; detail?: string }>
  /// The lifecycle sweep, run once per billed lease at the end of the money
  /// story. Nothing else writes `LeasePayer.lastSyncedAt`, so without it the
  /// Billing Runs panel on /money reports "Never synced" for every payer
  /// whose subscription this seed just created - five amber rows on the one
  /// screen that exists to say Stripe and the leases agree. Found by the
  /// Milestone 10 demo walk.
  syncLease: (leaseId: string) => Promise<{ outcome: string; reason: string; error?: string }[]>
  /// Only `cancelSubscription` is used, by `reset()`. Typed to that one
  /// method rather than to the whole `BillingProvider`, which lives behind
  /// the same `server-only` wall and so cannot be imported as a type here
  /// either.
  getBillingProvider: () => {
    cancelSubscription: (input: { stripeSubscriptionId: string }) => Promise<void>
    createSetupIntent: (
      stripeCustomerId: string,
    ) => Promise<{ setupIntentId: string; clientSecret: string }>
  }
}> | null = null

function loadBillingPipeline() {
  billingPipeline ??= (async () => {
    // Cast because the installed `@types/node` predates it. `registerHooks`
    // is Node's synchronous, in-process hook API (22.15+/24+) - no loader
    // thread, no `--import` flag, and it applies to every module resolved
    // after the call, which is why the imports below are dynamic.
    const { registerHooks } = (await import('node:module')) as unknown as {
      registerHooks: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown,
        ) => unknown
      }) => void
    }
    const root = resolve(import.meta.dirname, '../../..')
    registerHooks({
      resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) {
        if (specifier === 'server-only') {
          return {
            url: pathToFileURL(join(root, 'packages/core/testing/empty.ts')).href,
            shortCircuit: true,
          }
        }
        if (specifier.startsWith('@/')) {
          return next(pathToFileURL(join(root, 'apps/web', specifier.slice(2))).href, context)
        }
        return next(specifier, context)
      },
    })
    const [provision, webhook, provider, lifecycle] = await Promise.all([
      import(pathToFileURL(join(root, 'apps/web/lib/billing/provision.ts')).href),
      import(pathToFileURL(join(root, 'apps/web/lib/billing/webhook.ts')).href),
      import(pathToFileURL(join(root, 'apps/web/lib/billing/provider.ts')).href),
      import(pathToFileURL(join(root, 'apps/web/lib/billing/lifecycle.ts')).href),
    ])
    return {
      provisionLeaseBilling: provision.provisionLeaseBilling,
      processStripeEvent: webhook.processStripeEvent,
      getBillingProvider: provider.getBillingProvider,
      syncLease: lifecycle.syncLease,
    }
  })()
  return billingPipeline
}

/**
 * A saved payment method for this customer, ready for `setup_intent.succeeded`.
 *
 * THIS IS THE ONE PLACE THE SEED STANDS IN FOR A BROWSER, and it exists
 * because the alternative is a demo where autopay is silently off.
 * `createSetupIntent` is the product's own call (PAY-02: Stripe-hosted
 * fields, no card number ever reaches us) - but nothing CONFIRMS it except
 * the tenant tapping through those fields, and until something does, no
 * PaymentMethod exists to enrol.
 *
 * Inventing a `pm_...` id instead is what the first version did, and against
 * a real test-mode key Stripe refused it outright: "No such PaymentMethod".
 * Worth keeping as the record of why this function is here rather than a
 * one-line constant - the refusal is Stripe being right.
 *
 * `pm_card_visa` is Stripe's own always-available test PaymentMethod, and
 * the `sk_test_` guard is belt-and-braces: `StripeBillingProvider` already
 * refuses a live key at construction (D-26), so a live account cannot reach
 * this line - but a demo seed touching real cards would be bad enough to
 * check twice.
 */
async function savedPaymentMethod(
  provider: { createSetupIntent: (id: string) => Promise<{ setupIntentId: string }> },
  stripeCustomerId: string,
): Promise<{ setupIntentId: string; paymentMethodId: string }> {
  const { setupIntentId } = await provider.createSetupIntent(stripeCustomerId)

  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key?.startsWith('sk_test_')) {
    // The simulator, which has no PaymentMethods to speak of.
    return { setupIntentId, paymentMethodId: `pm_demo${randomUUID().replace(/-/g, '').slice(0, 16)}` }
  }

  const response = await fetch(`https://api.stripe.com/v1/setup_intents/${setupIntentId}/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ payment_method: 'pm_card_visa' }),
  })
  const body = (await response.json()) as { payment_method?: string; error?: { message?: string } }
  if (!response.ok || !body.payment_method) {
    throw new Error(
      `demo money: could not confirm setup intent ${setupIntentId} - ` +
        `${body.error?.message ?? response.statusText}`,
    )
  }
  return { setupIntentId, paymentMethodId: body.payment_method }
}

/// An event envelope in Stripe's own shape. `livemode: false` is not
/// decoration - these describe test-mode objects and nothing here should
/// ever be able to read as live money.
function stripeEvent(
  type: string,
  at: Date,
  object: Record<string, unknown>,
  previous?: Record<string, unknown>,
): StripeEventEnvelope {
  return {
    id: `evt_demo${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type,
    created: Math.floor(at.getTime() / 1000),
    livemode: false,
    data: previous ? { object, previous_attributes: previous } : { object },
  }
}

/// Invoice lines carrying OUR charge ids, which is the whole linkage - see
/// `InvoicePlan.carriesOverdueCharge`. An empty array is the normal case:
/// subscription rent has no `Charge` row of its own.
function invoiceLines(chargeIds: string[]) {
  return { data: chargeIds.map((chargeId) => ({ metadata: { chargeId } })) }
}

/**
 * Pushes one event through the real pipeline and REFUSES TO CONTINUE if it
 * did not do what the plan said.
 *
 * The check is the point. Every failure mode of this section is silent: an
 * event for a customer nobody knows is `ignored` with a reason, a replayed
 * id is a `duplicate`, and both leave the seed reporting success over a
 * demo with an empty rent roll. That is exactly the failure D-132 describes
 * - "an unrouted message is what that queue is for" - and the only defence
 * is to state the expected outcome at the call site.
 */
async function replay(
  processStripeEvent: (e: StripeEventEnvelope) => Promise<{ outcome: string; detail?: string }>,
  event: StripeEventEnvelope,
  expected: 'projected' | 'ignored',
  what: string,
) {
  const result = await processStripeEvent(event)
  if (result.outcome !== expected) {
    throw new Error(
      `demo money: ${what} came back ${result.outcome} (${result.detail ?? 'no detail'}), ` +
        `expected ${expected}. The pipeline is the product's own - a surprise here is a real one.`,
    )
  }
  return result
}

/**
 * The money story, once every lease and overdue charge it points at exists.
 *
 * Returns counts rather than logging its own line, so the seed's single
 * summary stays the one place that says what was built.
 */
async function seedMoney(
  targets: MoneyTarget[],
  demoLinks: DemoLink[],
): Promise<{ payers: number; events: number }> {
  const planned = targets.filter((target) => MONEY[target.lifecycle])
  if (planned.length === 0) return { payers: 0, events: 0 }

  const { provisionLeaseBilling, processStripeEvent, getBillingProvider, syncLease } =
    await loadBillingPipeline()
  const push = (event: StripeEventEnvelope, expected: 'projected' | 'ignored', what: string) =>
    replay(processStripeEvent, event, expected, what)

  let payers = 0
  let events = 0

  for (const target of planned) {
    const plan = MONEY[target.lifecycle]!

    // D-29, and the ordering is the decision: `provisionLeaseBilling`
    // creates the subscription with whatever collection method the payer row
    // already carries, so a payer who must be on `send_invoice` has to exist
    // BEFORE provisioning. Switching afterwards is R-047's guarded flow -
    // and it would refuse this payer anyway, because they have an open
    // invoice, which is precisely the guard working.
    if (plan.collectionMethod) {
      await prisma.leasePayer.create({
        data: {
          leaseId: target.leaseId,
          propertyId: target.propertyId,
          payerType: 'TENANT',
          tenantId: target.tenantId,
          // Null means "the remainder" - see the column's own comment.
          portionCents: null,
          collectionMethod: plan.collectionMethod,
        },
      })
    }

    const provisioned = await provisionLeaseBilling(target.leaseId)
    if (provisioned.outcome !== 'provisioned' || !provisioned.stripeCustomerId) {
      throw new Error(
        `demo money: could not provision billing for lease ${target.leaseId} ` +
          `(${provisioned.outcome}${provisioned.error ? `: ${provisioned.error}` : ''}).`,
      )
    }
    payers++
    const customer = provisioned.stripeCustomerId

    // ---- THE PART MONTH AT MOVE-IN, if provisioning raised one ----
    //
    // `chargeMoveInProration` runs inside provisioning (R-042) for any lease
    // that did not start on its own billing day, which is most of them here.
    // It leaves a real `Charge` and nothing on the ledger - so without this
    // every demo tenancy would carry a part-month rent charge showing as
    // fully outstanding for ever on the pay screen, months after it was
    // notionally settled. Billed and paid on the day the tenancy started,
    // which is when it actually happened.
    const partMonth = await prisma.charge.findFirst({
      where: { leaseId: target.leaseId, type: 'RENT', description: { startsWith: 'Part month' } },
      select: { id: true, amountCents: true },
    })
    if (partMonth) {
      const lease = await prisma.lease.findUniqueOrThrow({
        where: { id: target.leaseId },
        select: { startsOn: true },
      })
      const invoiceId = `in_demo${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const lines = invoiceLines([partMonth.id])
      await push(
        stripeEvent('invoice.finalized', lease.startsOn, {
          id: invoiceId,
          customer,
          amount_due: partMonth.amountCents,
          amount_paid: 0,
          description: 'Part month at move-in',
          lines,
        }),
        'projected',
        'the move-in part month',
      )
      await push(
        stripeEvent(
          'invoice.updated',
          lease.startsOn,
          {
            id: invoiceId,
            customer,
            amount_paid: partMonth.amountCents,
            description: 'Part month at move-in',
            lines,
          },
          { amount_paid: 0 },
        ),
        'projected',
        'the move-in part month payment',
      )
      events += 2
    }

    // ---- THE RENT MONTHS ----
    for (const invoice of plan.invoices) {
      const at = daysFrom(-invoice.daysAgo)
      const invoiceId = `in_demo${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const chargeIds =
        invoice.carriesOverdueCharge && target.overdueChargeId ? [target.overdueChargeId] : []
      const lines = invoiceLines(chargeIds)

      await push(
        stripeEvent('invoice.finalized', at, {
          id: invoiceId,
          customer,
          amount_due: target.rentCents,
          amount_paid: 0,
          description: 'Monthly rent',
          lines,
        }),
        'projected',
        `rent finalized ${invoice.daysAgo} days ago`,
      )
      events++

      // The decline comes FIRST, before any money arrives, because that is
      // the order it happens in: the card is tried, it fails, and whatever
      // is paid afterwards is the tenant sorting it out. It also matters to
      // the pipeline - a failure arriving after a settled payment on the
      // same intent is read as an ACH RETURN and reverses it, which is a
      // completely different story from a decline.
      if (invoice.declinedAfterDays != null) {
        await push(
          stripeEvent('invoice.payment_failed', daysFrom(-invoice.daysAgo + invoice.declinedAfterDays), {
            id: invoiceId,
            customer,
            amount_due: target.rentCents,
            payment_intent: `pi_demo${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          }),
          'projected',
          `the declined attempt ${invoice.daysAgo - invoice.declinedAfterDays} days ago`,
        )
        events++
      }

      // THE DELTA, NEVER THE TOTAL. `amount_paid` is cumulative across
      // instalments, so each event reports the running total and names the
      // previous one in `previous_attributes` - which is the subtraction the
      // interpreter does. Getting this wrong by sending the instalment
      // amount as `amount_paid` would credit $800 of a $1,600 invoice twice.
      const parts = invoice.paidCents === 'full' ? [target.rentCents] : invoice.paidCents
      let paidSoFar = 0
      for (const [index, part] of parts.entries()) {
        const before = paidSoFar
        paidSoFar += part
        await push(
          stripeEvent(
            'invoice.updated',
            // Instalments land days apart, not all at once - a part-payment
            // arriving in the same second as the one before it is a story
            // nobody would believe on a statement.
            daysFrom(-invoice.daysAgo + 1 + index * 6),
            {
              id: invoiceId,
              customer,
              amount_paid: paidSoFar,
              description: 'Rent payment',
              lines,
            },
            { amount_paid: before },
          ),
          'projected',
          `rent payment ${index + 1} of ${parts.length} on the invoice ${invoice.daysAgo} days ago`,
        )
        events++
      }
    }

    // ---- AN ACH DEBIT STILL IN FLIGHT ----
    //
    // `payment_intent.processing` with NO invoice behind it: a tenant-
    // initiated payment (R-037), which is the one PaymentIntent shape this
    // pipeline projects rather than leaving to the invoice events.
    if (plan.inFlight) {
      await push(
        stripeEvent('payment_intent.processing', daysFrom(-plan.inFlight.daysAgo), {
          id: `pi_demo${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          customer,
          amount: plan.inFlight.amountCents,
          payment_method_types: ['us_bank_account'],
        }),
        'projected',
        'the ACH debit in flight',
      )
      events++
    }

    // ---- AUTOPAY ----
    //
    // `ignored` is the CORRECT outcome here and not a failure: enrolment
    // moves no cents, so it never touches the ledger. The detail is what
    // says it worked, which is why it is checked rather than assumed.
    if (plan.autopayDaysAgo != null) {
      const saved = await savedPaymentMethod(getBillingProvider(), customer)
      const result = await push(
        stripeEvent('setup_intent.succeeded', daysFrom(-plan.autopayDaysAgo), {
          id: saved.setupIntentId,
          customer,
          payment_method: saved.paymentMethodId,
        }),
        'ignored',
        'the autopay enrolment',
      )
      if (!result.detail?.startsWith('autopay: enrolled')) {
        throw new Error(`demo money: autopay enrolment did nothing (${result.detail}).`)
      }
      events++
    }

    // ---- THE SWEEP, ONCE, LAST ----
    //
    // The product's own lifecycle sweep, not a written-in breadcrumb: it asks
    // Stripe, compares, and records what it did on the payer. Run after the
    // replay rather than before, so what it reconciles against is the state
    // every event above left behind. `in_sync` is the expected answer and a
    // failure is not fatal here - the demo money story is already correct
    // without it, and a sweep that could not reach the provider should not
    // take the whole seed down with it.
    for (const result of await syncLease(target.leaseId)) {
      if (result.error) {
        console.warn(`demo money: billing sweep on ${target.leaseId} said ${result.error}`)
      }
    }

    // ---- THE PAY LINK, ON THE TENANCY THAT OWES SOMETHING ----
    //
    // Last, because the payer row it is subject to is created by
    // `provisionLeaseBilling` for an autopay tenancy rather than above, and
    // because a link to a zero balance is a page saying there is nothing to
    // pay. `late` is the tenancy every other part of the demo already agrees
    // is behind - the notice, the eviction case and the overdue charge all
    // hang off it - so it is the one a "pay now" text would really go to.
    if (target.lifecycle === 'late') {
      const payer = await prisma.leasePayer.findFirst({
        where: { leaseId: target.leaseId, tenantId: target.tenantId, active: true },
        select: { id: true },
      })
      if (!payer) throw new Error(`demo money: no active payer on lease ${target.leaseId}`)
      await mintDemoLink(
        'TENANT_PAY_LINK',
        { type: 'LeasePayer', id: payer.id },
        {
          who: `the tenant at ${target.addressOfRecord}`,
          what: 'Pay rent without signing in',
        },
        demoLinks,
        // The tenant and lease are RECORDED, not inferred at use time - a
        // payer row edited between issue and use must not silently move who
        // the link belongs to. `verifyPayLink` refuses one without them.
        { tenantId: target.tenantId, leaseId: target.leaseId, notificationKey: null },
      )
    }
  }

  return { payers, events }
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

  // ---- The two reusable templates the screens above ask for ----
  //
  // Both are portfolio-level, like the vendors and PM schedules above.
  //
  // The checklist is `defaultForType: PERIODIC` rather than MOVE_OUT: only
  // the auto-scheduled types read that column (INSP-04), it is UNIQUE, and
  // MOVE_IN/MOVE_OUT/PRE_MOVE_OUT are lease-event-driven and never look it
  // up. Its rooms are the ones the walked inspections below use, so a viewer
  // opening "New inspection" is offered the list they have just seen filled
  // in - which is what a reusable checklist is FOR (INSP-01: the same list
  // walked at move-in and move-out is what makes the two comparable).
  const inspectionTemplate = await prisma.inspectionTemplate.create({
    data: {
      name: INSPECTION_TEMPLATE_NAME,
      defaultForType: 'PERIODIC',
      createdByStaffId: staff.id,
      items: [
        { room: 'Kitchen', item: 'Countertops' },
        { room: 'Kitchen', item: 'Appliances' },
        { room: 'Living room', item: 'Walls and paint' },
        { room: 'Primary bedroom', item: 'Flooring' },
        { room: 'Hallway', item: 'Carpet' },
        { room: 'Bathroom', item: 'Tub and surround' },
      ],
    },
  })

  // ROUTINE, not LEGAL - COMM-03 lets an unapproved translation be used for
  // one and not the other, and a rent reminder is the routine case. Every
  // `{{field}}` here is in core's closed catalogue (`MERGE_FIELDS`); a key
  // that is not would be refused at send time, which is exactly the failure a
  // demo template must not be carrying.
  await prisma.messageTemplate.create({
    data: {
      name: MESSAGE_TEMPLATE_NAME,
      kind: 'ROUTINE',
      subject: MESSAGE_TEMPLATE_SUBJECT,
      body: MESSAGE_TEMPLATE_BODY,
      createdByStaffId: staff.id,
    },
  })

  let propertyCount = 0
  let unitCount = 0
  let tenantCount = 0
  let ticketCount = 0
  let workOrderCount = 0
  let inspectionCount = 0
  let messageCount = 0
  let listingCount = 0
  let prospectCount = 0
  let photoCount = 0
  let caseCount = 0
  let complianceCount = 0
  /// The tenancies the money story attaches to (R-100c), collected here and
  /// spent after every property is written: an invoice that carries the
  /// overdue `Charge`'s id needs that charge to exist first.
  const moneyTargets: MoneyTarget[] = []
  /// Printed at the very end. The raw token exists only here - only its
  /// SHA-256 reaches the database - so a link not printed on this run is a
  /// link nobody can ever open.
  const demoLinks: DemoLink[] = []

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

      if (tenantPlan.lease.renewedPriorTerm) {
        const prior = tenantPlan.lease.renewedPriorTerm
        const predecessor = await prisma.lease.create({
          data: {
            propertyId: property.id,
            unitId: unit.id,
            status: 'ENDED',
            startsOn: prior.startsOn,
            endsOn: prior.endsOn,
            rentCents: prior.rentCents,
            depositCents: tenantPlan.lease.depositCents,
          },
        })
        await prisma.leaseTenant.create({
          data: { leaseId: predecessor.id, tenantId: tenant.id, isPrimary: true },
        })
        await prisma.lease.update({
          where: { id: lease.id },
          data: { renewedFromLeaseId: predecessor.id },
        })
      }

      // The deposit as a LIABILITY, which is a different fact from
      // `Lease.depositCents` and the one every screen actually reads.
      // `depositCents` is what the lease says should be collected - an
      // intention; `Deposit` is money that arrived and has not gone back.
      // `depositHeldCents` derives from the latter (R-071, deliberately -
      // see `packages/core/ledger/deposits.ts`), so a seed that sets only
      // the intention leaves the rent roll reporting "$0.00 held" against
      // five tenancies that each paid one, and hands the move-out persona a
      // disposition screen reading "This lease holds no deposit - there is
      // nothing to dispose of." R-128's demo walk found exactly that.
      //
      // Mirrors `deposit-clearing-job.ts`, which is the only thing that
      // writes this row in the real product: `heldCents` off the lease,
      // `receivedAt` when the move-in funds cleared, `type` left to its
      // SECURITY default.
      //
      // NOT the inherited tenancy. R-033's whole point is that nobody
      // established where that deposit went - `depositTransferStatus:
      // UNKNOWN` above says so - and a row asserting we hold it would
      // answer the question the outstanding-items path exists to raise.
      if (tenantPlan.lifecycle !== 'inherited-at-acquisition') {
        await prisma.deposit.create({
          data: {
            propertyId: property.id,
            leaseId: lease.id,
            heldCents: tenantPlan.lease.depositCents,
            // Received at the ORIGINAL move-in - a renewed tenancy's deposit
            // arrived under the predecessor term and followed the tenancy.
            receivedAt: tenantPlan.lease.renewedPriorTerm?.startsOn ?? tenantPlan.lease.startsOn,
          },
        })
      }

      const overdueCharge = tenantPlan.lease.overdueCharge
        ? await prisma.charge.create({
            data: {
              propertyId: property.id,
              leaseId: lease.id,
              type: 'RENT',
              amountCents: tenantPlan.lease.rentCents,
              description: 'Monthly rent',
              // The same day `MONEY.late` finalizes the invoice that carries
              // this charge's id. Two dates for one bill is two screens
              // disagreeing about when the tenant fell behind.
              dueOn: daysFrom(-20),
            },
          })
        : null

      moneyTargets.push({
        leaseId: lease.id,
        propertyId: property.id,
        tenantId: tenant.id,
        lifecycle: tenantPlan.lifecycle,
        rentCents: tenantPlan.lease.rentCents,
        overdueChargeId: overdueCharge?.id ?? null,
        addressOfRecord: `${plan.addressLine1} ${unit.name}`,
      })
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
        // What a notice states as the address it was served at. Read from
        // the property rather than composed at the notice, because a notice
        // is evidence and the address on it has to be the address of record.
        addressOfRecord: `${plan.addressLine1}, ${plan.city}, ${plan.state} ${plan.postalCode}`,
        unitId: unit.id,
        leaseId: lease?.id ?? null,
        tenantId: leaseTenant?.tenantId ?? null,
        staffId: staff.id,
        vendorRows,
        pmTemplateRows,
        inspectionTemplateId: inspectionTemplate.id,
        demoLinks,
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

    // ---- The leasing and risk story (R-100b) ----
    for (const unitPlan of plan.units) {
      const leasing = LEASING[`${plan.name}::${unitPlan.name}`]
      if (!leasing) continue

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

      const written = await seedLeasing(leasing, {
        propertyId: property.id,
        addressOfRecord: `${plan.addressLine1}, ${plan.city}, ${plan.state} ${plan.postalCode}`,
        unitId: unit.id,
        leaseId: lease?.id ?? null,
        tenantId: leaseTenant?.tenantId ?? null,
        staffId: staff.id,
        vendorRows,
        pmTemplateRows,
        inspectionTemplateId: inspectionTemplate.id,
        demoLinks,
        propertyName: plan.name,
        unitName: unitPlan.name,
      })
      photoCount += written.photos
      prospectCount += written.prospects
      caseCount += written.cases
      if (leasing.listing) listingCount++
    }
  }

  // ---- The money story (R-100c), replayed through the real pipeline ----
  //
  // LAST OF THE THREE STORIES AND DELIBERATELY SO. It reads the overdue
  // `Charge` written above, and it is the only section here that can make a
  // property permanently undeletable - see `reset()`'s sticky set.
  const money = await seedMoney(moneyTargets, demoLinks)

  // ---- The staff queue, LAST: it is derived from everything above ----
  const taskCount = await seedTasks(
    staff.id,
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entities.map((entity) => entity.id) } },
        select: { id: true },
      })
    ).map((property) => property.id),
  )

  // ---- Compliance items, which hang off a property or an entity ----
  for (const item of COMPLIANCE) {
    const propertyId =
      item.scope === 'PROPERTY'
        ? (
            await prisma.property.findFirstOrThrow({
              where: { name: item.propertyName, active: true },
              select: { id: true },
            })
          ).id
        : null
    await prisma.complianceItem.create({
      data: {
        type: item.type,
        label: item.label,
        dueOn: daysFrom(item.dueInDays),
        propertyId,
        legalEntityId: item.scope === 'ENTITY' ? entities[item.entityIndex ?? 0]!.id : null,
      },
    })
    complianceCount++
  }

  console.info(
    `Seeded demo data: ${entities.length} legal entities, ${propertyCount} properties, ` +
      `${unitCount} units, ${tenantCount} tenants, ${vendorRows.length} vendors, ` +
      `${pmTemplateRows.length} PM schedules, ${ticketCount} tickets, ` +
      `${workOrderCount} work orders, ${inspectionCount} inspections, ${messageCount} messages, ` +
      `${listingCount} listing, ${prospectCount} prospects, ${photoCount} photos, ` +
      `${caseCount} cases, ${complianceCount} compliance items, ${taskCount} tasks, ` +
      `${money.payers} billed payers, ${money.events} Stripe events replayed.`,
  )

  if (storageIsRemote) {
    console.info(
      '\nUnit photos were SKIPPED: BLOB_READ_WRITE_TOKEN is set, so uploads go to a shared\n' +
        'blob store this script has no business writing to. The listing is seeded without them.',
    )
  }

  // ---- The staff member's own calendar feed (NOTIF-06, R-097c) ----
  //
  // The one link here nobody hands to a stranger, and included for the same
  // reason as the rest: the token in the path is the entire credential, so a
  // walk that never opens one has never checked what it serves. Fetched by a
  // machine rather than read in a browser - `curl` it, or subscribe to it.
  await mintDemoLink(
    'CALENDAR_FEED',
    { type: 'StaffUser', id: staff.id },
    { who: 'the owner (staff)', what: 'Visit calendar feed (.ics, subscribe or curl)' },
    demoLinks,
  )

  // LAST, ALONE, AND LOUD. This is the only output of the whole run that
  // cannot be recovered by looking at the database afterwards: only the
  // SHA-256 of each token reaches the database, so a link not printed here is
  // a link nobody can ever open.
  console.info(
    `\n${'='.repeat(78)}\n` +
      `LIVE LINKS - ${demoLinks.length}, shown once. Every stranger-facing route in the\n` +
      'product opens from one of these. Only the hash is stored, so re-run the seed\n' +
      `to mint another set.\n${'='.repeat(78)}`,
  )
  for (const [index, link] of demoLinks.entries()) {
    console.info(`\n${index + 1}. ${link.what}\n   as ${link.who}\n   ${link.url}`)
  }
  console.info('')
}

async function main() {
  // Before `--reset`, not after: reset DELETES and RETIRES rows, so a run
  // pointed at the wrong database does its damage in the first statement.
  // `db:seed:demo` carried `-e .env.local` until R-137, which on this machine
  // is the Neon dev branch - the guard is what makes the npm script's env a
  // convenience rather than the only thing standing between a demo seed and
  // the cloud.
  refuseUnlessDemoDatabase('writes demo data', 'npm run db:seed:demo')
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
