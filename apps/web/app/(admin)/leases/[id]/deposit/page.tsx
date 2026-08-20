import { computeDisposition, depreciationGuidance, isUnsupportedDeduction } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AddDeductionForm } from '@/components/deposits/add-deduction-form.tsx'
import { FinalizeDispositionForm } from '@/components/deposits/finalize-disposition-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import {
  addDeduction,
  finalizeDisposition,
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
        <p className="text-muted-foreground text-sm">
          This lease holds no deposit - there is nothing to dispose of.
        </p>
      </div>
    )
  }

  // The letter already exists once finalized - the rest of this flow is
  // R-051's own page from here on.
  if (deposit.noticeId) redirect(`/notices/${deposit.noticeId}`)

  const [workOrders, inspectionItems, statement] = await Promise.all([
    workOrdersForUnit(lease.unitId),
    moveOutInspectionItemsForLease(lease.id),
    leaseStatement(lease.id, scope),
  ])

  const primaryTenant = lease.leaseTenants[0]?.tenant
  const tenantName = primaryTenant ? `${primaryTenant.firstName} ${primaryTenant.lastName}` : 'Tenant'
  const outstandingLedgerCents = statement?.balanceCents ?? 0
  const deductedCents = deposit.deductions.reduce((sum, d) => sum + d.amountCents, 0)
  const totals = computeDisposition(deposit.heldCents, deductedCents, outstandingLedgerCents)

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
            ` · due ${friendlyDate(deposit.dispositionDueOn, lease.property.timezone)}`}
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
                    <span className="text-sm text-amber-800 dark:text-amber-300">
                      Unsupported — no work order, move-out photo, or attached invoice.
                    </span>
                  )}
                  {guidance?.exceedsGuidance && (
                    <span className="text-sm text-amber-800 dark:text-amber-300">
                      Age-based guidance suggests at most {formatCents(guidance.suggestedMaxCents)} on
                      an item this old — full replacement cost rarely holds up in a dispute.
                    </span>
                  )}
                  <TaskActionButton action={removeDeduction.bind(null, deduction.id)} label="Remove" />
                </li>
              )
            })}
          </ul>
        )}

        <AddDeductionForm
          action={addDeduction.bind(null, deposit.id)}
          workOrders={workOrders.map((wo) => ({ id: wo.id, label: wo.scope }))}
          inspectionItems={inspectionItems.map((item) => ({
            id: item.id,
            label: `${item.room} — ${item.item}`,
          }))}
        />
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
              <dd className="text-amber-800 dark:text-amber-300">
                {formatCents(totals.additionalOwedCents)}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="finalize" className="flex flex-col gap-3 border-t pt-4">
        <h2 id="finalize" className="text-lg font-semibold">
          Finalize
        </h2>
        <p className="text-muted-foreground text-sm">
          Locks the deduction list, generates the disposition letter, and moves to recording how it
          was served. This cannot be undone once the letter exists.
        </p>
        <FinalizeDispositionForm
          action={finalizeDisposition.bind(null, deposit.id)}
          defaultForwardingAddress={deposit.forwardingAddress ?? lease.noticeForwardingAddress ?? ''}
        />
      </section>
    </div>
  )
}
