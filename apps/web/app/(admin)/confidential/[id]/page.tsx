import { businessDate, friendlyDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CaseDetailsPanel,
  CloseCasePanel,
  EarlyTerminationPanel,
  LockChangePanel,
  RemovePartyPanel,
} from '@/components/confidential/case-panels.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import {
  closeConfidentialCase,
  orderLockChange,
  recordEarlyTermination,
  startConfidentialBifurcation,
  updateConfidentialCase,
} from '@/lib/confidential/actions.ts'
import { getConfidentialCase } from '@/lib/confidential/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = {
  title: 'Confidential — Rental Operations',
  robots: { index: false, follow: false },
}

// One confidential safety case (RISK-04, ROLE-05; R-091).
//
// 404, NEVER 403, for a case outside scope (ROLE-01). The rule matters more
// here than anywhere else it applies in this product: "forbidden" on a case
// id confirms a case with that id exists, which is the one fact this whole
// feature is built to withhold. The permission check above it redirects to
// /no-access identically for every id and for none, so it discloses nothing
// either.
//
// NO `loading.tsx` HERE OR ABOVE - R-099's rule, and here the 404 it would
// silently turn into a 200 is load-bearing rather than tidy.
export default async function ConfidentialCasePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // `requireScope` asks "does this actor hold the permission over ANYTHING",
  // and then the scoped query decides. That ordering is what makes the 404
  // below reachable: a resource-carrying `requirePermission` would answer
  // /no-access for a case at a property outside your reach, which is a 403
  // wearing a redirect - it confirms the case is there. A resource-LESS one
  // is worse still and simply broken, refusing every scoped actor (see
  // `requireScope`'s own comment).
  const { actor } = await requireScope('confidential.read')
  const scope = await currentScope(actor)
  const found = await getConfidentialCase(id, scope)
  if (!found) notFound()

  const zone = found.lease.property.timezone
  // `actorCan`, never a caught `requirePermission`: that one denies by
  // calling `redirect()`, which throws a control-flow error Next is meant to
  // catch, so wrapping it in a try/catch here would swallow the redirect and
  // silently render the page to somebody who was being sent away.
  const canManage = await actorCan('confidential.manage', propertyResource(found.lease.property))
  const today = businessDate(new Date(), zone)
  const leaseIsRunning =
    found.lease.status === 'ACTIVE' || found.lease.status === 'MONTH_TO_MONTH'

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">
          <Link href="/confidential" className="underline underline-offset-4">
            Confidential
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {found.lease.property.name} — {found.lease.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {found.status === 'OPEN' ? 'Open' : 'Closed'} · opened{' '}
          {friendlyDate(found.openedAt, zone)} by {found.openedBy.name} ·{' '}
          <Link href={`/leases/${found.lease.id}`} className="underline underline-offset-4">
            the tenancy
          </Link>
        </p>
        <p className="text-muted-foreground text-sm">
          Everything on this page is restricted. It is not shown on the tenancy, in search, in
          any queue, or to anybody without the confidential permission.
        </p>
      </header>

      <CaseDetailsPanel
        summary={found.summary}
        restrictedPartyName={found.restrictedPartyName}
        restrictedPartyTenantId={found.restrictedPartyTenantId}
        documentationType={found.documentationType}
        documentedOn={found.documentedOn ? utcToBusinessDate(found.documentedOn) : null}
        documentationSeenBy={found.documentationSeenBy?.name ?? null}
        tenantOptions={found.lease.leaseTenants.map((lt) => ({
          id: lt.tenant.id,
          label: `${lt.tenant.firstName} ${lt.tenant.lastName}`,
        }))}
        closed={found.status === 'CLOSED' || !canManage}
        action={updateConfidentialCase.bind(null, found.id)}
      />

      {canManage && (
        <LockChangePanel
          ordered={found.lockChangeWorkOrderId != null}
          workOrderId={found.lockChangeWorkOrderId}
          workOrderStatus={found.lockChangeWorkOrder?.status ?? null}
          action={orderLockChange.bind(null, found.id)}
        />
      )}

      {/* R-091b. Both are only offered on a tenancy that is still running:
          neither the statutory right nor a change of parties means anything
          on a lease that has already ended, and the case itself deliberately
          outlives the tenancy (see `validateConfidentialCase`). */}
      {canManage && leaseIsRunning && (
        <EarlyTerminationPanel
          recorded={found.earlyTerminationRecordedAt != null}
          effectiveOn={
            found.lease.noticeEffectiveOn
              ? utcToBusinessDate(found.lease.noticeEffectiveOn)
              : null
          }
          hasDocumentation={found.documentationType != null}
          today={today}
          action={recordEarlyTermination.bind(null, found.id)}
        />
      )}

      {canManage && leaseIsRunning && (
        <RemovePartyPanel
          sent={found.partyChangeId != null}
          changeId={found.partyChangeId}
          restrictedPartyName={found.restrictedPartyName}
          restrictedPartyOnLease={found.restrictedPartyTenantId != null}
          today={today}
          action={startConfidentialBifurcation.bind(null, found.id)}
        />
      )}

      {(canManage || found.status === 'CLOSED') && (
        <CloseCasePanel
          closed={found.status === 'CLOSED' || !canManage}
          closedNote={found.closedNote}
          closedOn={found.closedAt ? friendlyDate(found.closedAt, zone) : null}
          action={closeConfidentialCase.bind(null, found.id)}
        />
      )}
    </div>
  )
}
