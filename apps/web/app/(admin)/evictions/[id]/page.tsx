import {
  costTotals,
  CURE_STATE_LABELS,
  EVICTION_COST_LABELS,
  EVICTION_COST_TYPES,
  EVICTION_OUTCOME_LABELS,
  EVICTION_OUTCOMES,
  EVICTION_STAGE_LABELS,
  FILING_REFUSAL_MESSAGES,
  isEvictionCostType,
  isEvictionOutcome,
  LOST_RENT_IS_DERIVED,
  readyToFile,
  type EvictionStageValue,
} from '@rental/core/evictions'
import { formatCents } from '@rental/core/money'
import { noticeTypeLabel } from '@rental/core/notices'
import {
  AFFIDAVIT_REFUSAL_MESSAGES,
  affidavitReadiness,
  staleLookupWarning,
} from '@rental/core/scra'
import {
  businessDate,
  friendlyBusinessDate,
  friendlyDate,
  friendlyTimestamp,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Fragment } from 'react'
import {
  AdvanceStagePanel,
  AttachNoticePanel,
  CloseCasePanel,
  ExportPacketPanel,
  RecordCostPanel,
} from '@/components/evictions/case-panels.tsx'
import { HoldBanner } from '@/components/holds/hold-banner.tsx'
import { ScraLookupsPanel } from '@/components/scra/scra-panels.tsx'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import {
  advanceEvictionStage,
  attachNoticeToCase,
  recordEvictionCost,
} from '@/lib/evictions/actions.ts'
import { holdsForLease } from '@/lib/holds/queries.ts'
import { recordScraLookup } from '@/lib/scra/actions.ts'
import { affidavitLookupFor, lookupsForLease } from '@/lib/scra/queries.ts'
import { exportAttorneyPacket } from '@/lib/evictions/packet.ts'
import { attachableNotices, cureClockFor, getEvictionCase } from '@/lib/evictions/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Eviction case — Rental Operations' }

/// Which stage follows which, and what date that stage actually records. The
/// labels are deliberately specific - "date" on a court form is never just a
/// date, and a PM typing the hearing date into a field marked "filed on" has
/// produced a false record, not a typo.
const NEXT_STAGE: Partial<
  Record<EvictionStageValue, { stage: EvictionStageValue; label: string; dateLabel: string; needsTime: boolean }>
> = {
  NOTICE: { stage: 'FILING', label: 'Record the filing', dateLabel: 'Date filed', needsTime: false },
  FILING: { stage: 'COURT', label: 'Record the court date', dateLabel: 'Hearing date and time', needsTime: true },
  COURT: { stage: 'JUDGMENT', label: 'Record the judgment', dateLabel: 'Date of judgment', needsTime: false },
  JUDGMENT: { stage: 'WRIT', label: 'Record the writ', dateLabel: 'Date the writ issued', needsTime: false },
  WRIT: { stage: 'LOCKOUT', label: 'Record the lockout', dateLabel: 'Date of lockout', needsTime: false },
}

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound().
export default async function EvictionCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('eviction.manage')
  const scope = await currentScope(actor)
  const evictionCase = await getEvictionCase(id, scope)
  if (!evictionCase) notFound()

  const zone = evictionCase.property.timezone
  const { clock, hasNotice } = await cureClockFor(evictionCase)
  const stage = evictionCase.stage as EvictionStageValue
  const next = NEXT_STAGE[stage]
  const totals = costTotals(evictionCase.costs)
  const attachable = await attachableNotices(evictionCase.leaseId)
  // R-084. The screen where a hold matters most: SCRA needs an affidavit
  // before a default judgment, a bankruptcy stay bars the filing outright,
  // and a dead tenant has nobody to serve.
  const holds = await holdsForLease(evictionCase.leaseId)

  // R-085 (RISK-12). Shown BEFORE the PM tries to record a judgment, for the
  // same reason `filingReadiness` is shown before they try to file: the gate
  // exists to prevent an expensive mistake, and a gate that only speaks after
  // the attempt teaches somebody to work around it.
  const [scraLookups, affidavitLookup] = await Promise.all([
    lookupsForLease(evictionCase.leaseId),
    affidavitLookupFor(evictionCase.leaseId),
  ])
  const affidavit = affidavitReadiness({
    // The gate itself asks; here we are only PREVIEWING what a default
    // judgment would run into, so this deliberately assumes the worst case.
    tenantAppeared: false,
    lookup: affidavitLookup,
    today: businessDate(new Date(), zone),
  })

  // Shown BEFORE the PM tries, not as an error after - the whole point of
  // the gate is that filing early is expensive and irreversible.
  const filingReadiness = next?.stage === 'FILING' ? readyToFile(clock, hasNotice) : null

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/evictions"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Evictions
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {evictionCase.property.name} — {evictionCase.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {evictionCase.lease.leaseTenants
            .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)
            .join(', ') || 'No tenant recorded'}{' '}
          · {EVICTION_STAGE_LABELS[stage]} · opened {friendlyDate(evictionCase.openedAt, zone)} by{' '}
          {evictionCase.openedBy.name}
        </p>
      </header>

      <HoldBanner
        context="Nothing on this page is blocked"
        holds={holds
          .filter((hold) => hold.liftedAt === null)
          .map((hold) => ({
            type: hold.type,
            reason: hold.reason,
            placedOn: friendlyDate(hold.placedAt, zone),
            placedByName: hold.placedByName,
          }))}
      />

      <section aria-labelledby="clock" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="clock" className="text-lg font-semibold">
          Service and the cure period
        </h2>
        <p className="text-sm">{CURE_STATE_LABELS[clock.state]}</p>
        {clock.runsFrom && <p className="text-muted-foreground text-sm">Runs from {clock.runsFrom}.</p>}
        {clock.cureBy ? (
          <p className="text-muted-foreground text-sm">Last day to cure is {clock.cureBy}.</p>
        ) : (
          clock.periodUnknown && (
            <p className="text-sm text-amber-800">
              This state&rsquo;s cure period is not configured in this system, so no deadline is shown. Ask your
              attorney — a date guessed here is the one that gets a case dismissed.
            </p>
          )
        )}
      </section>

      <ScraLookupsPanel
        lookups={scraLookups}
        canRecord={stage !== 'CLOSED'}
        recordAction={recordScraLookup.bind(null, evictionCase.leaseId)}
        evictionCaseId={evictionCase.id}
        tenants={evictionCase.lease.leaseTenants.map((lt) => ({
          id: lt.tenant.id,
          name: `${lt.tenant.firstName} ${lt.tenant.lastName}`,
        }))}
        prompt={
          stage === 'CLOSED'
            ? undefined
            : !affidavit.ready
              ? AFFIDAVIT_REFUSAL_MESSAGES[affidavit.refusal!]
              : affidavit.stale
                ? staleLookupWarning(affidavit.staleDays!)
                : undefined
        }
      />

      <section aria-labelledby="notices" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="notices" className="text-lg font-semibold">
          Notices filed under this case
        </h2>
        {evictionCase.notices.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {evictionCase.notices.map((notice) => (
              <li key={notice.id} className="flex flex-col">
                <Link href={`/notices/${notice.id}`} className="font-medium underline underline-offset-2">
                  {noticeTypeLabel(notice.type)}
                </Link>
                {notice.deliveries.length === 0 ? (
                  <span className="text-muted-foreground">Not served yet.</span>
                ) : (
                  notice.deliveries.map((delivery) => (
                    <span key={delivery.id} className="text-muted-foreground">
                      Served {delivery.method.toLowerCase().replace(/_/g, ' ')} on{' '}
                      {friendlyDate(delivery.servedAt, zone)}
                      {delivery.permittedByJurisdiction === false && (
                        <span className="text-red-800">
                          {' '}
                          — this state does not name that method for this notice
                        </span>
                      )}
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>
        )}
        {attachable.length > 0 && stage !== 'CLOSED' && (
          <AttachNoticePanel
            action={attachNoticeToCase.bind(null, evictionCase.id)}
            notices={attachable.map((notice) => ({
              value: notice.id,
              label: `${noticeTypeLabel(notice.type)} — ${
                notice.servedAt ? `served ${friendlyDate(notice.servedAt, zone)}` : 'not served'
              }`,
            }))}
          />
        )}
      </section>

      <section aria-labelledby="dates" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="dates" className="text-lg font-semibold">
          Case dates
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {(
            [
              ['Filed', evictionCase.filedOn ? friendlyBusinessDate(utcToBusinessDate(evictionCase.filedOn)) : null],
              ['Court date', evictionCase.courtDate ? friendlyTimestamp(evictionCase.courtDate, zone) : null],
              ['Judgment', evictionCase.judgmentOn ? friendlyBusinessDate(utcToBusinessDate(evictionCase.judgmentOn)) : null],
              [
                'Writ of possession',
                evictionCase.writOn ? friendlyBusinessDate(utcToBusinessDate(evictionCase.writOn)) : null,
              ],
              ['Lockout', evictionCase.lockoutOn ? friendlyBusinessDate(utcToBusinessDate(evictionCase.lockoutOn)) : null],
            ] as const
          )
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
        </dl>
        {evictionCase.outcome && (
          <p className="text-sm">
            <span className="font-medium">
              {isEvictionOutcome(evictionCase.outcome)
                ? EVICTION_OUTCOME_LABELS[evictionCase.outcome]
                : evictionCase.outcome}
            </span>
            {evictionCase.outcomeNote ? ` — ${evictionCase.outcomeNote}` : ''}
          </p>
        )}
      </section>

      {stage !== 'CLOSED' && (
        <section aria-labelledby="advance" className="flex flex-col gap-4 rounded-md border p-4">
          <h2 id="advance" className="text-lg font-semibold">
            Record what happened next
          </h2>
          {next && filingReadiness && !filingReadiness.ready ? (
            <p className="text-sm text-amber-800">
              {FILING_REFUSAL_MESSAGES[filingReadiness.refusal!]}
            </p>
          ) : (
            next && (
              <AdvanceStagePanel
                action={advanceEvictionStage.bind(null, evictionCase.id)}
                nextStage={next.stage}
                nextLabel={next.label}
                dateLabel={next.dateLabel}
                needsTime={next.needsTime}
              />
            )
          )}
          <div className="border-t pt-4">
            <h3 className="mb-2 text-sm font-medium">Close this case</h3>
            <CloseCasePanel
              action={advanceEvictionStage.bind(null, evictionCase.id)}
              outcomes={EVICTION_OUTCOMES.map((value) => ({
                value,
                label: EVICTION_OUTCOME_LABELS[value],
              }))}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="costs" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="costs" className="text-lg font-semibold">
          What this has cost
        </h2>
        {evictionCase.costs.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {Object.entries(totals.byType).map(([type, cents]) => (
              <Fragment key={type}>
                <dt className="text-muted-foreground">
                  {isEvictionCostType(type) ? EVICTION_COST_LABELS[type] : type}
                </dt>
                <dd>{formatCents(cents)}</dd>
              </Fragment>
            ))}
            <dt className="font-medium">Total</dt>
            <dd className="font-medium">{formatCents(totals.totalCents)}</dd>
          </dl>
        )}
        <p className="text-muted-foreground text-xs">{LOST_RENT_IS_DERIVED}</p>
        {stage !== 'CLOSED' && (
          <RecordCostPanel
            action={recordEvictionCost.bind(null, evictionCase.id)}
            costTypes={EVICTION_COST_TYPES.map((value) => ({ value, label: EVICTION_COST_LABELS[value] }))}
          />
        )}
      </section>

      <section aria-labelledby="packet" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="packet" className="text-lg font-semibold">
          Attorney packet
        </h2>
        <p className="text-muted-foreground text-sm">
          One file: this case summary, the statement of account, every notice with its proof of service, the executed
          lease and the photographs on record. Anything that cannot be attached is named on the index rather than
          quietly left out.
        </p>
        <ExportPacketPanel action={exportAttorneyPacket.bind(null, evictionCase.id)} />
      </section>
    </div>
  )
}
