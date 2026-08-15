import { actualTotalCents, compareBids } from '@rental/core/approvals'
import { earliestCompliantStart } from '@rental/core/entry'
import { utcToWallClock, businessDate } from '@rental/core/scheduling'
import { formatCents } from '@rental/core/money'
import {
  activeWarranties,
  jobCostCents,
  likelyMatchingWarranty,
  vendorReopenRates,
} from '@rental/core/workorders'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { ApprovalPanel } from '@/components/workorders/approval-panel.tsx'
import { BidsPanel } from '@/components/workorders/bids-panel.tsx'
import { AssignForm } from '@/components/workorders/assign-form.tsx'
import { ClosePanel } from '@/components/workorders/close-panel.tsx'
import { RecordActualsForm } from '@/components/workorders/record-actuals-form.tsx'
import { ScheduleForm } from '@/components/workorders/schedule-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { TimelineSection } from '@/components/workorders/timeline-section.tsx'
import { actorCan, actorDecision, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import {
  addWorkOrderNote,
  assignWorkOrder,
  attachMessageToWorkOrder,
  closeWorkOrder,
  dispatchToVendor,
  markWorkComplete,
  replyToTenantFromWorkOrder,
  replyToVendorFromWorkOrder,
  setWorkOrderWarrantyHold,
} from '@/lib/workorders/actions.ts'
import {
  decideApproval,
  recordActuals,
  requestBids,
  submitForApproval,
} from '@/lib/workorders/approvals.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { unattachedTenantMessages, workOrderTimeline } from '@/lib/workorders/timeline.ts'
import { verificationsFor, vendorVerificationRows } from '@/lib/workorders/verify.ts'
import {
  logEntryPermission,
  logTenantNoShow,
  scheduleEntry,
} from '@/lib/workorders/scheduling.ts'
import {
  activeVendors,
  getWorkOrder,
  jobContextForWorkOrder,
  staffForWorkOrderAssignment,
  warrantiesForProperty,
} from '@/lib/workorders/queries.ts'

export const metadata = { title: 'Work order — Rental Operations' }

/// Mirrors APPROVAL_DEFAULTS.bidThresholdCents - imported as a constant
/// rather than re-deriving the whole policy here, since this page only needs
/// the one number to decide whether to show the panel.
const BID_THRESHOLD_FALLBACK = 250_000

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}
const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  TRIAGED: 'Triaged',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  ASSIGNED: 'Assigned',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  WORK_COMPLETE: 'Work complete',
  VERIFIED: 'Verified',
  INVOICED: 'Invoiced',
  CLOSED: 'Closed',
  ON_HOLD_WARRANTY: 'On hold — warranty claim',
  WAITING_ON_TENANT: 'Waiting on tenant',
  CANCELED: 'Canceled',
}

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('workorder.read')
  const scope = await currentScope(actor)

  const workOrder = await getWorkOrder(id, scope)
  if (!workOrder) notFound()

  const canWrite = await actorCan('workorder.write', propertyResource(workOrder.property))
  const canSeeVendors = await actorCan('vendor.read', propertyResource(workOrder.property))

  const [warranties, staff, vendors] = await Promise.all([
    warrantiesForProperty(workOrder.propertyId).then((w) => activeWarranties(w, new Date())),
    canWrite ? staffForWorkOrderAssignment(workOrder.propertyId) : Promise.resolve([]),
    canWrite && canSeeVendors ? activeVendors() : Promise.resolve([]),
  ])
  const likely = workOrder.ticket
    ? likelyMatchingWarranty(workOrder.ticket.category, warranties)
    : null

  const unassigned = !workOrder.assignedStaffId && !workOrder.vendorId
  const resolved = workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED'

  // R-030. Every answer ever given about this job, newest first - a single
  // `verifiedAt` column could not hold them once a job has come back twice,
  // and the earlier "no" is the evidence that the reopen was justified.
  const answers = (await verificationsFor(workOrder.id)).map((row) => ({
    resolved: row.resolved,
    rating: row.rating,
    comment: row.comment,
    respondedAt: row.respondedAt.toISOString(),
    vendorName: row.vendor?.name ?? null,
    round: row.round,
  }))
  const currentRound = workOrder.reopenCount + 1
  const closable =
    workOrder.status === 'WORK_COMPLETE' || workOrder.status === 'VERIFIED'

  // How often this vendor's work comes back (MAINT-07, MAINT-10), shown at
  // the point of decision rather than buried in a report nobody opens. Read
  // from the verification rows' own captured vendor, never from whoever the
  // work order names now - see the schema comment on that column.
  const vendorRecord =
    workOrder.vendorId && canSeeVendors
      ? vendorReopenRates(await vendorVerificationRows(workOrder.vendorId), 3)[0]
      : undefined
  // COMM-06, R-032: the merged timeline - tenant thread, vendor thread and
  // staff notes, one chronological view.
  const rawEntries = await workOrderTimeline(workOrder.id)
  const timelineEntries = rawEntries.map((entry) => ({
    ...entry,
    atLocal: utcToWallClock(entry.at, workOrder.property.timezone).replace('T', ' '),
  }))
  const unattached = canWrite
    ? (await unattachedTenantMessages(workOrder.id)).map((message) => ({
        id: message.id,
        body: message.body,
        sentAt: utcToWallClock(message.sentAt, workOrder.property.timezone).replace(
          'T',
          ' ',
        ),
      }))
    : []
  const tenantChannels = workOrder.ticket?.tenant
    ? [
        'PORTAL',
        ...(workOrder.ticket.tenant.email ? ['EMAIL'] : []),
        ...(workOrder.ticket.tenant.phone ? ['SMS'] : []),
      ]
    : []

  const onHold = workOrder.status === 'ON_HOLD_WARRANTY'
  const awaitingApproval = workOrder.status === 'PENDING_APPROVAL'
  const approveDecision = await actorDecision('workorder.approve', propertyResource(workOrder.property))
  const jobContext = awaitingApproval ? await jobContextForWorkOrder(workOrder, scope) : null

  // MAINT-04's bid workflow. Shown once anybody has been asked, or whenever
  // the job is big enough that asking is the policy - not on every $40 work
  // order, where a bid table would be noise.
  const bidRows = await prisma.workOrderBid.findMany({
    where: { workOrderId: workOrder.id },
    include: { vendor: { select: { id: true, name: true } } },
  })
  const comparison =
    bidRows.length > 0
      ? compareBids(
          bidRows.map((b) => ({
            vendorId: b.vendorId,
            vendorName: b.vendor.name,
            amountCents: b.amountCents,
            declinedAt: b.declinedAt,
            respondedAt: b.respondedAt,
          })),
        )
      : null
  // Read straight from the entity rather than widening the shared
  // workOrderInclude every list query also pays for.
  // The jurisdiction's own entry-notice period (D-4, R-027). Read through
  // rulesFor(), never as a literal - see lib/workorders/scheduling.ts.
  // Tolerated as null when no rule is configured for the state, so an
  // unconfigured jurisdiction shows the form rather than 500ing the page.
  const entryRule = await rulesFor(
    { state: workOrder.property.state, county: workOrder.property.county },
    new Date(),
  ).catch(() => null)
  const isEmergency = workOrder.priority === 'EMERGENCY'
  // Every time on this page is the PROPERTY's wall clock, not the server's.
  // `toISOString()` here rendered raw UTC beside a legal entry notice that
  // renders property-local, so the PM's screen and the tenant's notice
  // disagreed by the offset unless the server happened to sit in the
  // property's timezone. `localInput` also feeds `datetime-local` inputs,
  // which is the same value the scheduling action now parses back with
  // `wallClockToUtc` - the round trip only holds if both ends use the
  // property's zone.
  const zone = workOrder.property.timezone
  const localInput = (value: Date | null) =>
    value ? utcToWallClock(value, zone) : null
  const localTime = (value: Date) => utcToWallClock(value, zone).replace('T', ' ')

  const entity = await prisma.legalEntity.findUnique({
    where: { id: workOrder.property.legalEntityId },
    select: { bidThresholdCents: true },
  })
  const bidsExpected =
    workOrder.estimateCents != null &&
    workOrder.estimateCents > (entity?.bidThresholdCents ?? BID_THRESHOLD_FALLBACK)
  const VENDOR_RESPONSE_LABELS: Record<string, string> = {
    ACCEPTED: 'Accepted',
    DECLINED: 'Declined',
    PROPOSED_TIME: 'Proposed a time',
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          <Link href="/workorders" className="underline underline-offset-4">
            {workOrder.property.name}
          </Link>
          {' — '}
          {workOrder.unit.name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {workOrder.scope.slice(0, 80)}
        </h1>
      </header>

      {warranties.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className="font-medium">Warranty status (PROP-06)</p>
          {warranties.map((w) => (
            <p
              key={w.id}
              className={w.id === likely?.id ? 'font-medium' : 'text-muted-foreground'}
            >
              {w.category} — {w.provider}
              {w.expiresOn && ` (expires ${w.expiresOn.toISOString().slice(0, 10)})`}
              {w.id === likely?.id && ' — likely covers this'}
            </p>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Priority</dt>
        <dd className="col-span-1 sm:col-span-2">
          {PRIORITY_LABELS[workOrder.priority] ?? workOrder.priority}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[workOrder.status] ?? workOrder.status}
          {workOrder.warrantyClaim && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
              Warranty claim
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Estimate</dt>
        <dd className="col-span-1 sm:col-span-2">
          {workOrder.estimateCents != null
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                workOrder.estimateCents / 100,
              )
            : 'Not estimated'}
        </dd>
        <dt className="text-muted-foreground">Assigned to</dt>
        <dd className="col-span-1 sm:col-span-2">
          {workOrder.assignedTo?.name ?? workOrder.vendor?.name ?? 'Unassigned'}
        </dd>
        {workOrder.scheduledStart && (
          <>
            <dt className="text-muted-foreground">Scheduled</dt>
            <dd className="col-span-1 sm:col-span-2">
              {localTime(workOrder.scheduledStart)}
              {workOrder.scheduledEnd && ` to ${localTime(workOrder.scheduledEnd).slice(11)}`}
              {workOrder.entryOverrideReason && (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  Entry override logged
                </span>
              )}
              {workOrder.tenantNoShowAt && (
                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
                  Tenant no-show
                </span>
              )}
            </dd>
          </>
        )}
        {workOrder.vendorId && (
          <>
            <dt className="text-muted-foreground">Vendor link</dt>
            <dd className="col-span-1 sm:col-span-2">
              {workOrder.dispatchedAt
                ? `Sent ${localTime(workOrder.dispatchedAt)}`
                : 'Not sent yet'}
            </dd>
            {vendorRecord && (
              <>
                <dt className="text-muted-foreground">Vendor record</dt>
                <dd className="col-span-1 sm:col-span-2">
                  {`${vendorRecord.reopened} of ${vendorRecord.verified} jobs came back (${Math.round(vendorRecord.reopenRate * 100)}%)`}
                  {vendorRecord.averageRating != null &&
                    ` · rated ${vendorRecord.averageRating.toFixed(1)}/5`}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Vendor said</dt>
            <dd className="col-span-1 sm:col-span-2">
              {workOrder.vendorResponse
                ? (VENDOR_RESPONSE_LABELS[workOrder.vendorResponse] ?? workOrder.vendorResponse)
                : 'No answer yet'}
              {workOrder.vendorDeclineReason && ` — ${workOrder.vendorDeclineReason}`}
              {workOrder.proposedStart &&
                ` — ${localTime(workOrder.proposedStart)} to ${workOrder.proposedEnd ? localTime(workOrder.proposedEnd).slice(11) : ''}`}
            </dd>
          </>
        )}
        {workOrder.ticket && (
          <>
            <dt className="text-muted-foreground">From ticket</dt>
            <dd className="col-span-1 sm:col-span-2">
              <Link
                href={`/maintenance/${workOrder.ticket.id}`}
                className="underline underline-offset-4"
              >
                {workOrder.ticket.description.slice(0, 60)}
              </Link>
            </dd>
          </>
        )}
      </dl>

      {canWrite && !resolved && (comparison != null || bidsExpected) && (
        <BidsPanel
          comparison={comparison}
          vendors={vendors}
          requestAction={requestBids.bind(null, workOrder.id)}
        />
      )}

      {awaitingApproval && (
        <ApprovalPanel
          workOrder={{
            scope: workOrder.scope,
            estimateCents: workOrder.estimateCents,
            approvedAmountCents: workOrder.approvedAmountCents,
            actualTotalCents: actualTotalCents(workOrder),
            approvalQuestion: workOrder.approvalQuestion,
            propertyName: workOrder.property.name,
            unitName: workOrder.unit.name,
          }}
          photos={(jobContext?.photos ?? []).map((p) => ({
            id: p.id,
            fileName: p.fileName,
            href: `/api/documents/${p.id}/file`,
          }))}
          decideAction={decideApproval.bind(null, workOrder.id)}
          canDecide={approveDecision?.allowed === true}
          needsMfa={approveDecision?.allowed === false && approveDecision.reason === 'mfa_required'}
        />
      )}

      {canWrite && !resolved && (
        <div className="flex flex-col gap-6 border-t pt-4">
          {unassigned && (staff.length > 0 || vendors.length > 0) && !onHold && (
            <AssignForm
              action={assignWorkOrder.bind(null, workOrder.id)}
              staff={staff}
              vendors={vendors}
            />
          )}
          {!awaitingApproval && workOrder.status !== 'APPROVED' && (
            <TaskActionButton
              action={submitForApproval.bind(null, workOrder.id)}
              label="Check approval / send for approval"
            />
          )}
          <ScheduleForm
            action={scheduleEntry.bind(null, workOrder.id)}
            entryNoticeHours={entryRule?.entryNoticeHours ?? null}
            earliestCompliant={
              entryRule?.entryNoticeHours != null
                ? localTime(
                    earliestCompliantStart(new Date(), entryRule.entryNoticeHours),
                  )
                : null
            }
            scheduledStart={localInput(workOrder.scheduledStart)}
            scheduledEnd={localInput(workOrder.scheduledEnd)}
            hasPermission={workOrder.entryPermissionGrantedAt != null}
            isEmergency={isEmergency}
          />
          {workOrder.entryPermissionGrantedAt == null && !isEmergency && (
            <TaskActionButton
              action={logEntryPermission.bind(null, workOrder.id)}
              label="Tenant gave permission to enter"
            />
          )}
          {workOrder.scheduledStart && workOrder.tenantNoShowAt == null && (
            <TaskActionButton
              action={logTenantNoShow.bind(null, workOrder.id)}
              label="Tenant did not show"
            />
          )}
          <RecordActualsForm
            action={recordActuals.bind(null, workOrder.id)}
            actualLaborCents={workOrder.actualLaborCents}
            actualMaterialsCents={workOrder.actualMaterialsCents}
          />
          {/*
            Marking complete is what asks the tenant (MAINT-07). Offered
            only once there is work to have finished - a job nobody has
            started cannot be complete, and the button existing beforehand
            invites exactly that click.
          */}
          {!closable &&
            workOrder.status !== 'SUBMITTED' &&
            workOrder.status !== 'PENDING_APPROVAL' && (
              <TaskActionButton
                action={markWorkComplete.bind(null, workOrder.id)}
                label="Mark the work complete (asks the tenant to confirm)"
              />
            )}
          {workOrder.vendorId && (
            <TaskActionButton
              action={dispatchToVendor.bind(null, workOrder.id)}
              label={
                workOrder.dispatchedAt
                  ? 'Resend the vendor link (revokes the old one)'
                  : 'Send the vendor their link'
              }
            />
          )}
          {onHold ? (
            <TaskActionButton
              action={setWorkOrderWarrantyHold.bind(null, workOrder.id, false)}
              label="Resume from warranty hold"
            />
          ) : (
            <TaskActionButton
              action={setWorkOrderWarrantyHold.bind(null, workOrder.id, true)}
              label="Put on hold for warranty claim"
            />
          )}
        </div>
      )}

      {/*
        The closed record, rendered from the row rather than from a toast.
        A success message living in the close panel's own state would vanish
        with the panel the instant `revalidatePath` re-rendered this page -
        and "closed without the tenant ever confirming it" is precisely the
        caveat somebody needs to see months later, not for two seconds.
      */}
      {workOrder.status === 'CLOSED' && (
        <section aria-labelledby="closed" className="flex flex-col gap-2 border-t pt-4">
          <h2 id="closed" className="text-lg font-semibold">
            Closed
          </h2>
          <p className="text-sm">
            {workOrder.closedAt
              ? `Closed ${businessDate(workOrder.closedAt, workOrder.property.timezone)}`
              : 'Closed'}
            {` · ${formatCents(jobCostCents(workOrder))}`}
            {workOrder.tenantCaused && ' · tenant-caused'}
          </p>
          {answers.some((a) => a.resolved) ? (
            <p className="text-muted-foreground text-sm">
              The tenant confirmed this was fixed.
            </p>
          ) : (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              The tenant never confirmed this one.
            </p>
          )}
        </section>
      )}

      {canWrite && closable && (
        <ClosePanel
          invoiceCents={workOrder.invoiceCents}
          currentAnswer={answers.find((a) => a.round === currentRound) ?? null}
          history={answers}
          closeAction={closeWorkOrder.bind(null, workOrder.id)}
        />
      )}

      <TimelineSection
        workOrderId={workOrder.id}
        entries={timelineEntries}
        canWrite={canWrite}
        tenantChannels={tenantChannels}
        hasVendor={workOrder.vendorId != null}
        unattached={unattached}
        addNote={addWorkOrderNote.bind(null, workOrder.id)}
        replyToTenant={replyToTenantFromWorkOrder.bind(null, workOrder.id)}
        replyToVendor={replyToVendorFromWorkOrder.bind(null, workOrder.id)}
        attachMessage={attachMessageToWorkOrder.bind(null, workOrder.id)}
      />
    </div>
  )
}
