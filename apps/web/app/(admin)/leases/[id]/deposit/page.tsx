import { computeDisposition, depreciationGuidance, isUnsupportedDeduction } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { DEPOSIT_REFUND_INSTRUMENTS, type DepositRefundInstrument } from '@rental/core/ledger'
import { businessDate, friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AddDeductionForm } from '@/components/deposits/add-deduction-form.tsx'
import { FinalizeDispositionForm } from '@/components/deposits/finalize-disposition-form.tsx'
import { RecordRefundForm } from '@/components/deposits/record-refund-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import {
  addDeduction,
  finalizeDisposition,
  recordDepositRefund,
  removeDeduction,
} from '@/lib/deposits/actions.ts'
import {
  getDepositForLease,
  moveOutInspectionItemsForLease,
  workOrdersForUnit,
} from '@/lib/deposits/queries.ts'
import { leaseStatement } from '@/lib/ledger/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Deposit disposition — Rental Operations' }

// The deposit disposition (INSP-03, R-071): itemized deductions, each
// linked to evidence or flagged unsupported; a depreciation check on each;
// running totals; and a finalize step that locks the list and hands off to
// R-051's own notice machinery for the actual letter and its service.
//
// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound().

export default async function DepositDispositionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)

  const lease = await getDepositForLease(id, scope)
  if (!lease) notFound()

  const deposit = lease.deposits[0]
  if (!deposit) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <Link
          href={`/leases/${id}`}
          className="text-muted-foreground hover:text-foreground w-fit text-sm underline underline-offset-2"
        >
          ← Lease
        </Link>
        {/* A page with no h1 is a page a screen-reader user cannot orient in,
            and this branch had none - the heading lived only in the branch
            below it. Found by the Milestone 10 demo walk. */}
        <h1 className="text-2xl font-semibold tracking-tight">
          Deposit disposition — {lease.property.name} {lease.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          This lease holds no deposit - there is nothing to dispose of.
        </p>
      </div>
    )
  }

  // Once finalized the letter is R-051's own page from here on - EXCEPT
  // while a refund it promised is still unpaid (R-170). Redirecting on the
  // letter alone is how the one screen that could record the disbursement
  // became unreachable the instant the disbursement became due.
  const finalized = deposit.noticeId != null
  const refundOutstanding = deposit.refundedCents > 0 && deposit.refundPaidOn == null
  // A disposition that refunded nothing has nothing left to do here, which
  // is every case this page had before R-170. One that refunded something
  // keeps its own screen for good: first to record the disbursement, then
  // to hold the record of it - the evidence produced when a former tenant
  // says the money never came back.
  if (finalized && deposit.refundedCents === 0) redirect(`/notices/${deposit.noticeId}`)

  const [workOrders, inspectionItems, statement] = await Promise.all([
    workOrdersForUnit(lease.unitId),
    moveOutInspectionItemsForLease(lease.id),
    leaseStatement(lease.id, scope),
  ])

  const primaryTenant = lease.leaseTenants[0]?.tenant
  const tenantName = primaryTenant ? `${primaryTenant.firstName} ${primaryTenant.lastName}` : 'Tenant'
  const outstandingLedgerCents = statement?.balanceCents ?? 0
  const deductedCents = deposit.deductions.reduce((sum, d) => sum + d.amountCents, 0)
  // Recomputed while the list is still a draft; READ BACK once finalized.
  // The letter's arithmetic is locked at the instant it was written, and a
  // charge landing on the ledger afterwards must not quietly change the
  // number the tenant was promised - which is also the number this page now
  // asks somebody to pay.
  const totals = finalized
    ? {
        ...computeDisposition(deposit.heldCents, deductedCents, outstandingLedgerCents),
        appliedCents: deposit.appliedCents,
        refundedCents: deposit.refundedCents,
      }
    : computeDisposition(deposit.heldCents, deductedCents, outstandingLedgerCents)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href={`/leases/${id}`}
          className="text-muted-foreground hover:text-foreground w-fit text-sm underline underline-offset-2"
        >
          ← Lease
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Deposit disposition — {lease.property.name} {lease.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {tenantName} · held {formatCents(deposit.heldCents)}
          {deposit.dispositionDueOn &&
            ` · due ${friendlyBusinessDate(utcToBusinessDate(deposit.dispositionDueOn))}`}
        </p>
      </header>

      <section aria-labelledby="deductions" className="flex flex-col gap-4">
        <h2 id="deductions" className="text-lg font-semibold">
          Deductions
        </h2>
        {deposit.deductions.length === 0 ? (
          <p className="text-muted-foreground text-sm">None recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {deposit.deductions.map((deduction) => {
              const unsupported = isUnsupportedDeduction({
                workOrderId: deduction.workOrder?.id ?? null,
                inspectionItemId: deduction.inspectionItem?.id ?? null,
                evidenceDocumentCount: deduction.evidence.length,
              })
              const guidance =
                deduction.estimatedAgeYears != null && deduction.usefulLifeYears != null
                  ? depreciationGuidance(
                      deduction.amountCents,
                      deduction.estimatedAgeYears,
                      deduction.usefulLifeYears,
                    )
                  : null
              return (
                <li key={deduction.id} className="flex flex-col gap-1 px-4 py-3">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{deduction.description}</span>
                    <span className="tabular-nums">{formatCents(deduction.amountCents)}</span>
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {deduction.workOrder && `Work order: ${deduction.workOrder.scope}`}
                    {deduction.inspectionItem &&
                      `Move-out photo: ${deduction.inspectionItem.room} — ${deduction.inspectionItem.item}`}
                    {deduction.evidence.length > 0 &&
                      ` · ${deduction.evidence.length} file(s) attached`}
                  </span>
                  {unsupported && (
                    <span className="text-sm text-amber-800">
                      Unsupported — no work order, move-out photo, or attached invoice.
                    </span>
                  )}
                  {guidance?.exceedsGuidance && (
                    <span className="text-sm text-amber-800">
                      Age-based guidance suggests at most {formatCents(guidance.suggestedMaxCents)} on
                      an item this old — full replacement cost rarely holds up in a dispute.
                    </span>
                  )}
                  {/* Names the deduction (R-116): one per row, and pressing
                      the wrong "Remove" takes money off the letter. Gone once
                      finalized - the action refuses it anyway, and a control
                      that can only fail is worse than no control. */}
                  {!finalized && (
                    <TaskActionButton
                      action={removeDeduction.bind(null, deduction.id)}
                      label={
                        <>
                          Remove
                          <span className="sr-only"> the {deduction.description} deduction</span>
                        </>
                      }
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {!finalized && (
          <AddDeductionForm
            action={addDeduction.bind(null, deposit.id)}
            workOrders={workOrders.map((wo) => ({ id: wo.id, label: wo.scope }))}
            inspectionItems={inspectionItems.map((item) => ({
              id: item.id,
              label: `${item.room} — ${item.item}`,
            }))}
          />
        )}
      </section>

      <section aria-labelledby="totals" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="totals" className="text-lg font-semibold">
          Totals
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Held</dt>
          <dd>{formatCents(totals.heldCents)}</dd>
          <dt className="text-muted-foreground">Deductions</dt>
          <dd>{formatCents(totals.deductedCents)}</dd>
          {totals.outstandingLedgerCents > 0 && (
            <>
              <dt className="text-muted-foreground">Outstanding balance</dt>
              <dd>{formatCents(totals.outstandingLedgerCents)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Refund due</dt>
          <dd>{formatCents(totals.refundedCents)}</dd>
          {totals.additionalOwedCents > 0 && (
            <>
              <dt className="text-muted-foreground">Still owed after deposit</dt>
              <dd className="text-amber-800">
                {formatCents(totals.additionalOwedCents)}
              </dd>
            </>
          )}
        </dl>
      </section>

      {finalized ? (
        <section aria-labelledby="refund" className="flex flex-col gap-3 border-t pt-4">
          <h2 id="refund" className="text-lg font-semibold">
            Refund payment
          </h2>
          <p className="text-muted-foreground text-sm">
            The disposition letter is written and{' '}
            <Link
              href={`/notices/${deposit.noticeId}`}
              className="underline underline-offset-2"
            >
              records its own service
            </Link>
            .{' '}
            {refundOutstanding
              ? `It promised ${formatCents(deposit.refundedCents)} back — until that money actually leaves, the deposit stays on the rent roll and the year-end packet as a liability.`
              : `${formatCents(deposit.refundedCents)} was returned to the tenant and the deposit is fully accounted for.`}
          </p>
          {refundOutstanding ? (
            <RecordRefundForm
              action={recordDepositRefund.bind(null, deposit.id)}
              amountLabel={formatCents(deposit.refundedCents)}
              today={businessDate(new Date(), lease.property.timezone)}
            />
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-4 text-sm">
              <dt className="text-muted-foreground">Paid on</dt>
              <dd>{friendlyBusinessDate(utcToBusinessDate(deposit.refundPaidOn!))}</dd>
              <dt className="text-muted-foreground">Paid by</dt>
              <dd>
                {DEPOSIT_REFUND_INSTRUMENTS[
                  deposit.refundMethod as DepositRefundInstrument
                ] ?? deposit.refundMethod}
              </dd>
              {deposit.refundReference && (
                <>
                  <dt className="text-muted-foreground">Reference</dt>
                  <dd>{deposit.refundReference}</dd>
                </>
              )}
              {deposit.refundDocumentId && (
                <>
                  <dt className="text-muted-foreground">Proof</dt>
                  <dd>
                    <a
                      href={`/api/documents/${deposit.refundDocumentId}/file`}
                      className="underline underline-offset-2"
                    >
                      Check image or remittance advice
                    </a>
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>
      ) : (
        <section aria-labelledby="finalize" className="flex flex-col gap-3 border-t pt-4">
          <h2 id="finalize" className="text-lg font-semibold">
            Finalize
          </h2>
          <p className="text-muted-foreground text-sm">
            Locks the deduction list, generates the disposition letter, and moves to recording how
            it was served. This cannot be undone once the letter exists.
          </p>
          <FinalizeDispositionForm
            action={finalizeDisposition.bind(null, deposit.id)}
            defaultForwardingAddress={
              deposit.forwardingAddress ?? lease.noticeForwardingAddress ?? ''
            }
          />
        </section>
      )}
    </div>
  )
}
