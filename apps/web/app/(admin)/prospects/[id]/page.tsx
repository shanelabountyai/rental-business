import {
  friendlyBusinessDate,
  friendlyDate,
  friendlyTimestamp,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { InviteToApplyForm } from '@/components/applications/invite-to-apply-form.tsx'
import { ProspectStageForm } from '@/components/prospects/prospect-stage-form.tsx'
import { ScreeningDecisionForm } from '@/components/screening/screening-decision-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { inviteToApply } from '@/lib/applications/staff-actions.ts'
import { applicationForProspect } from '@/lib/applications/queries.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { advanceProspectStage } from '@/lib/prospects/staff-actions.ts'
import { prospectForWrite } from '@/lib/prospects/queries.ts'
import { recordScreeningDecision } from '@/lib/screening/staff-actions.ts'
import { screeningForApplication } from '@/lib/screening/queries.ts'
import { cancelShowing } from '@/lib/showings/staff-actions.ts'
import { showingsForProspect } from '@/lib/showings/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

const CRITERION_LABELS: Record<string, string> = {
  income: 'Income',
  credit: 'Credit',
  eviction: 'Eviction history',
  criminal: 'Criminal history',
}

const DECISION_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  APPROVED_WITH_CONDITIONS: 'Approved with conditions',
  DECLINED: 'Declined',
}

export const metadata = { title: 'Prospect — Rental Operations' }

const STATUS_LABELS: Record<string, string> = {
  INQUIRY: 'Inquiry',
  PRE_SCREENED: 'Pre-screened',
  SHOWING: 'Showing',
  APPLIED: 'Applied',
  SCREENED: 'Screened',
  APPROVED: 'Approved',
  SIGNED: 'Signed',
}

const INCOME_RANGE_LABELS: Record<string, string> = {
  UNDER_3000: 'Under $3,000/mo',
  RANGE_3000_5000: '$3,000–$5,000/mo',
  RANGE_5000_8000: '$5,000–$8,000/mo',
  OVER_8000: 'Over $8,000/mo',
}

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)

  const prospect = await prospectForWrite(id, scope)
  if (!prospect) notFound()

  // The zone every timestamp on this page is read in. `prospectForWrite`
  // returns a bare `Prospect`, so it is fetched here rather than widening
  // that query's return type for its other callers - the same shape
  // `tasks/[id]` uses.
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: prospect.propertyId },
    select: { timezone: true },
  })

  const answered = prospect.preScreenRespondedAt != null
  const showings = await showingsForProspect(id)
  const application = await applicationForProspect(id, scope)
  const screening = application?.completedAt
    ? await screeningForApplication(application.id, scope)
    : null

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/prospects"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Prospects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {prospect.firstName} {prospect.lastName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {STATUS_LABELS[prospect.status] ?? prospect.status} · from {prospect.source}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Email</dt>
        <dd className="col-span-1 sm:col-span-2">{prospect.email ?? '—'}</dd>
        <dt className="text-muted-foreground">Phone</dt>
        <dd className="col-span-1 sm:col-span-2">{prospect.phone ?? '—'}</dd>
        {prospect.message && (
          <>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="col-span-1 sm:col-span-2">{prospect.message}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="prescreen" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="prescreen" className="text-sm font-semibold">
          Pre-screening
        </h2>
        {!answered ? (
          prospect.preScreenSentAt ? (
            <p className="text-muted-foreground text-sm">
              Sent {friendlyDate(prospect.preScreenSentAt, property.timezone)} - no answer yet.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">Not sent yet.</p>
          )
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Move date</dt>
            <dd>
              {prospect.moveDate
                ? friendlyBusinessDate(utcToBusinessDate(prospect.moveDate))
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Occupants</dt>
            <dd>{prospect.occupants ?? '—'}</dd>
            <dt className="text-muted-foreground">Pets</dt>
            <dd>{prospect.petsDescription || 'None mentioned'}</dd>
            <dt className="text-muted-foreground">Income range</dt>
            <dd>
              {prospect.incomeRange
                ? (INCOME_RANGE_LABELS[prospect.incomeRange] ?? prospect.incomeRange)
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Prior evictions</dt>
            <dd>
              {prospect.priorEvictions == null
                ? '—'
                : prospect.priorEvictions
                  ? `Yes — ${prospect.priorEvictionsDetail ?? ''}`
                  : 'No'}
            </dd>
          </dl>
        )}
      </section>

      {showings.length > 0 && (
        <section aria-labelledby="showings" className="flex flex-col gap-3 rounded-md border p-4">
          <h2 id="showings" className="text-sm font-semibold">
            Showing
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {showings.map((showing) => (
              <li key={showing.id} className="flex items-center justify-between gap-3 rounded border p-2">
                <span>
                  {showing.unit.name} — {friendlyTimestamp(showing.scheduledStart, showing.property.timezone)}
                  {showing.status === 'CANCELED' && ' (cancelled)'}
                </span>
                {showing.status === 'BOOKED' && (
                  <TaskActionButton
                    action={cancelShowing.bind(null, showing.id)}
                    label={
                      <>
                        Cancel<span className="sr-only"> the {showing.unit.name} showing</span>
                      </>
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {answered && (
        <section aria-labelledby="application" className="flex flex-col gap-3 rounded-md border p-4">
          <h2 id="application" className="text-sm font-semibold">
            Application
          </h2>
          {!application ? (
            <>
              <p className="text-muted-foreground text-sm">Not invited to apply yet.</p>
              <InviteToApplyForm action={inviteToApply.bind(null, prospect.id)} />
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                {application.completedAt
                  ? `Complete ${friendlyDate(application.completedAt, property.timezone)}.`
                  : 'In progress.'}
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {application.applicants.map((a) => (
                  <li key={a.id} className="rounded border p-2">
                    <span className="font-medium">
                      {a.firstName} {a.lastName}
                    </span>
                    {a.isLead ? ' (lead)' : ''}
                    {' — '}
                    {a.completedAt
                      ? 'done'
                      : a.formSubmittedAt
                        ? a.feeCents
                          ? a.feePaidAt
                            ? 'fee paid, finishing up'
                            : 'waiting on fee'
                          : 'submitted'
                        : 'in progress'}
                    {' · '}
                    {a.documentCount} document{a.documentCount === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {screening && (
        <section aria-labelledby="screening" className="flex flex-col gap-3 rounded-md border p-4">
          <h2 id="screening" className="text-sm font-semibold">
            Screening
          </h2>
          <ul className="flex flex-col gap-3 text-sm">
            {screening.applicants.map((a) => (
              <li key={a.applicantId} className="flex flex-col gap-2 rounded border p-2">
                <span className="font-medium">
                  {a.firstName} {a.lastName}
                </span>
                {a.reportStatus === 'NONE' && (
                  <p className="text-muted-foreground">No report ordered yet.</p>
                )}
                {a.reportStatus === 'FAILED' && (
                  <p className="text-red-700">
                    The report failed. Not evaluated against criteria.
                  </p>
                )}
                {(a.reportStatus === 'COMPLETE' || a.reportStatus === 'ORDERED') && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                    {a.criteria.map((c) => (
                      <span key={c.key} className="contents">
                        <dt className="text-muted-foreground">{CRITERION_LABELS[c.key]}</dt>
                        <dd
                          className={
                            c.result === 'FAILS'
                              ? 'text-red-700'
                              : c.result === 'UNKNOWN'
                                ? 'text-muted-foreground'
                                : ''
                          }
                        >
                          {c.detail}
                        </dd>
                      </span>
                    ))}
                  </dl>
                )}
                {a.decision ? (
                  <p>
                    <span className="font-medium">{DECISION_LABELS[a.decision] ?? a.decision}</span>
                    {a.decisionNotes && <span> — {a.decisionNotes}</span>}
                  </p>
                ) : null}
                {a.adverseAction && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Adverse-action notice: </span>
                    {a.adverseAction.sentAt ? (
                      <span className="text-green-800">
                        Sent {friendlyDate(a.adverseAction.sentAt, property.timezone)}
                      </span>
                    ) : a.adverseAction.overriddenAt ? (
                      <span className="text-amber-800">
                        Not sent — overridden{' '}
                        {friendlyDate(a.adverseAction.overriddenAt, property.timezone)}
                      </span>
                    ) : (
                      <span className="text-red-700">Not sent yet</span>
                    )}{' '}
                    <Link
                      href={`/notices/${a.adverseAction.noticeId}`}
                      className="underline underline-offset-2"
                    >
                      view
                    </Link>
                  </p>
                )}
                {!a.decision && (
                  a.reportStatus === 'COMPLETE' && (
                    <ScreeningDecisionForm
                      action={recordScreeningDecision}
                      applicantId={a.applicantId}
                      applicantName={`${a.firstName} ${a.lastName}`}
                      outOfOrder={screening.outOfOrder}
                    />
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {answered && (
        <section aria-labelledby="stage" className="flex flex-col gap-2 rounded-md border p-4">
          <h2 id="stage" className="text-sm font-semibold">
            Pipeline
          </h2>
          <p className="text-muted-foreground text-sm">
            A showing invite sends automatically once pre-screening is answered, and the
            prospect books their own slot above. Screening orders itself once an application
            completes; this records everything else by hand.
          </p>
          <ProspectStageForm
            action={advanceProspectStage.bind(null, prospect.id)}
            currentStatus={prospect.status}
          />
        </section>
      )}
    </div>
  )
}
