import { formatPhone } from '@rental/core/comms'
import {
  CONDITION_BASELINE_DOCUMENT_TYPE,
  type LeaseStatusValue,
  depositTransferLabel,
  leaseStatusLabel,
  leaseTransition,
} from '@rental/core/leases'
import { depositObligations } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AccessCodesPanel } from '@/components/leases/access-codes-panel.tsx'
import { BillingPanel } from '@/components/leases/billing-panel.tsx'
import { PaymentHoldPanel } from '@/components/leases/payment-hold-panel.tsx'
import { EsignPanel } from '@/components/leases/esign-panel.tsx'
import { IntakePanel } from '@/components/leases/intake-panel.tsx'
import { LedgerPanel } from '@/components/leases/ledger-panel.tsx'
import { ExportStatementForm } from '@/components/ledger/export-statement-form.tsx'
import { LeaseForm } from '@/components/leases/lease-form.tsx'
import { LifecyclePanel } from '@/components/leases/lifecycle-panel.tsx'
import { FeesPanel } from '@/components/leases/fees-panel.tsx'
import { RecurringChargesPanel } from '@/components/leases/recurring-panel.tsx'
import { PartiesPanel } from '@/components/leases/parties-panel.tsx'
import { RenewalPanel } from '@/components/leases/renewal-panel.tsx'
import { RenterInsurancePanel } from '@/components/leases/renter-insurance-panel.tsx'
import { accessCodesForLease } from '@/lib/leases/access-code-queries.ts'
import { OfflinePaymentForm } from '@/components/payments/offline-payment-form.tsx'
import { actorCan, actorDecision, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import {
  addGuarantor,
  addLeaseTenant,
  changeLeaseStatus,
  recordLeaseNotice,
  removeLeaseTenant,
  resolveIntakeItem,
  updateLeaseTerms,
} from '@/lib/leases/actions.ts'
import { generateAndSendLease, voidEnvelope } from '@/lib/leases/esign-staff-actions.ts'
import { resyncLease, setPaymentHold } from '@/lib/billing/actions.ts'
import { billingIsLive, billingProviderName } from '@/lib/billing/provider.ts'
import { leaseBillingState } from '@/lib/billing/provision.ts'
import { recurringChargesForLease } from '@/lib/billing/recurring.ts'
import { addRecurringCharge, endRecurringCharge } from '@/lib/billing/recurring-actions.ts'
import { leaseStatement, waivableFees } from '@/lib/ledger/queries.ts'
import { exportLedgerStatement } from '@/lib/ledger/statement.ts'
import { waiveCharge } from '@/lib/ledger/waivers.ts'
import { outstandingIntakeGaps } from '@/lib/leases/intake.ts'
import { recordRenterInsurance } from '@/lib/leases/insurance-actions.ts'
import { offerRenewal } from '@/lib/leases/renewal-actions.ts'
import { recordOfflinePayment } from '@/lib/payments/offline.ts'
import { getLease, selectableTenants } from '@/lib/leases/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Lease — Rental Operations' }

// One tenancy in full (LEASE-06, RISK-08, R-033).

/// Every transition the machine would currently allow, asked once here so
/// the UI never re-implements the rules. `leaseTransition` is consulted
/// with the real facts, which is why an incomplete lease shows no "make it
/// active" button rather than one that refuses when pressed.
const OFFER_LABELS: Record<string, string> = {
  // NOT PENDING_SIGNATURE - that transition now only happens through
  // "Generate & send for e-signature" below, which actually produces a
  // document and signer links. A bare status flip with nothing behind it
  // would leave the lease PENDING_SIGNATURE with no envelope for anyone to
  // sign (R-063).
  ACTIVE: 'Make this lease active',
  MONTH_TO_MONTH: 'Roll over to month-to-month',
  ENDED: 'Record that the tenancy ended',
  TERMINATED: 'Terminate this tenancy',
}

const UTILITY_LABELS: Record<string, string> = {
  electricity: 'Electricity',
  gas: 'Gas',
  water: 'Water',
  sewer: 'Sewer',
  trash: 'Trash',
  internet: 'Internet',
  lawn: 'Lawn care',
  pest: 'Pest control',
}

export default async function LeaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)

  const lease = await getLease(id, scope)
  // Out of scope and does not exist are indistinguishable - the same call
  // every other detail page in this product makes.
  if (!lease) notFound()

  // What this state demands of money held on trust (D-4, R-041). Read from
  // the versioned rule rather than hardcoded, and empty for a state nobody
  // has configured - the same posture late fees, NSF fees and the deposit cap
  // all take.
  const depositRule = await rulesFor(
    { state: lease.property.state, county: lease.property.county },
    new Date(),
  ).catch(() => null)
  const depositRules = depositRule
    ? depositObligations(depositRule, lease.depositArrangement)
    : []

  const canWrite = await actorCan('lease.write', propertyResource(lease.property))
  // Recording money that arrived off the rails is the most forgeable action
  // in the product - there is no processor on the other side to disagree -
  // so it sits behind the privileged permission, not behind lease.write.
  const canRecordPayment = await actorCan('ledger.adjust', propertyResource(lease.property))
  // Waiving is DIFFERENT and deliberately lower: R-004 gave managers
  // `fee.waive` because forgiving a late fee is day-to-day work, and their
  // role explicitly cannot adjust the ledger. The amount is then checked
  // against their own ceiling inside the action.
  // `actorDecision`, not `actorCan`: forgiving money is a PRIVILEGED
  // permission and R-004 requires a verified second factor for it, so
  // "cannot waive" has two very different meanings here. Collapsing both to
  // false renders an empty space to somebody who holds the permission and
  // only needs to verify.
  const waiveDecision = await actorDecision('fee.waive', propertyResource(lease.property))
  // PAY-12's controls stop a tenancy's collection in support of an eviction,
  // so they run on `ledger.adjust` — the same privileged permission a ledger
  // adjustment needs, with a proved second factor (R-047).
  const holdDecision = await actorDecision('ledger.adjust', propertyResource(lease.property))
  // R-063: generating a lease and sending it for e-signature makes a
  // legally binding document and, on completion, moves money - the same bar
  // `screening.decide` sets for its own permission.
  const execDecision = await actorDecision('lease.execute', propertyResource(lease.property))
  // R-069: releasing a code to the tenant is privileged/MFA-gated like
  // `accesscode.reveal`, but a plain `actorCan` is enough here - unlike the
  // decisions above, the panel never offers an "issue" button to someone who
  // cannot yet act, so there is no "allowed but needs MFA" state to render.
  const canIssue = await actorCan('accesscode.issue', propertyResource(lease.property))

  const currentEnvelope = lease.envelopes[0] ?? null
  const envelopeIsLive = currentEnvelope
    ? currentEnvelope.status === 'SENT' || currentEnvelope.status === 'PARTIALLY_SIGNED'
    : false

  const facts = {
    status: lease.status,
    tenantCount: lease.leaseTenants.length,
    rentCents: lease.rentCents,
    startsOn: lease.startsOn,
    endsOn: lease.endsOn,
    isMonthToMonth: lease.isMonthToMonth,
  }
  const offers = (['ACTIVE', 'MONTH_TO_MONTH', 'ENDED', 'TERMINATED'] as const)
    .filter((to) => {
      // A lease out for signature only activates through the esign
      // completion path (every signer signed) - the generic button is
      // hidden while that is in flight, matching the refusal
      // `changeLeaseStatus` itself now gives if this filter is ever wrong.
      if (to === 'ACTIVE' && lease.status === 'PENDING_SIGNATURE' && envelopeIsLive) return false
      // TERMINATED always needs a reason, which the form collects - so it is
      // asked WITH one, or it would never be offered.
      const decision = leaseTransition(facts, to, to === 'TERMINATED' ? 'x' : undefined)
      return decision.allowed
    })
    .map((to: LeaseStatusValue) => ({
      to,
      label: OFFER_LABELS[to] ?? to,
      needsReason: to === 'TERMINATED',
      // Bound HERE, on the server. A `(to) => action.bind(...)` factory
      // handed to the client component instead is refused at runtime -
      // only a 'use server' export has an identity the client can call.
      action: changeLeaseStatus.bind(null, lease.id, to),
    }))

  const [gaps, tenants, payers, ledger, fees, recurring, accessCodes] = await Promise.all([
    outstandingIntakeGaps(lease),
    canWrite ? selectableTenants() : Promise.resolve([]),
    leaseBillingState(lease.id),
    leaseStatement(lease.id, scope),
    waivableFees(lease.id),
    recurringChargesForLease(lease.id),
    accessCodesForLease(lease.unitId, lease.id),
  ])
  // R-069: nothing to clear on a zero-deposit lease (NONE/SURETY_BOND hold
  // zero by the database CHECK constraint `chargeDeposit()`'s own comment
  // names) - `lease.deposits` only ever populates from the deposit-clearing
  // job once real cash has cleared.
  const depositCleared = lease.depositCents === 0 || lease.deposits.length > 0
  // LEASE-09 (R-065): the 120/90-day job is what FLAGS a lease (raises the
  // Task a PM's queue shows); the offer form itself is not gated behind that
  // flag existing - a PM asked about renewing early, or who already closed
  // the flag Task, is not blocked from making an offer, the same posture
  // `changeLeaseStatus`'s own buttons take (available whenever the move is
  // legal, never behind some other artifact). `existingSuccessor` blocks a
  // second concurrent offer, the same guard `offerRenewal` re-checks itself.
  const existingSuccessor = lease.renewalLeases.find((r) =>
    (['DRAFT', 'PENDING_SIGNATURE', 'ACTIVE'] as const).includes(r.status as never),
  )
  const canOfferRenewal =
    canWrite && !existingSuccessor && (lease.status === 'ACTIVE' || lease.status === 'MONTH_TO_MONTH')
  // Plain UTC-midnight arithmetic, deliberately not `businessDate()`
  // (property-local), when starting from `endsOn`: that column is a
  // @db.Date, always UTC midnight for its calendar day (CLAUDE.md's own
  // warning on this exact column type) - adding whole days in that same
  // UTC frame and reading the result with `utcToBusinessDate` never crosses
  // a timezone boundary. The no-`endsOn` fallback (an MTM lease with no
  // term to count from) starts from a real instant instead, so THAT one
  // does need the property's own zone.
  const renewalDefaultStartsOn = lease.endsOn
    ? utcToBusinessDate(new Date(lease.endsOn.getTime() + 24 * 3_600_000))
    : businessDate(new Date(), lease.property.timezone)
  const renewalDefaultEndsOn = utcToBusinessDate(
    new Date(new Date(`${renewalDefaultStartsOn}T00:00:00.000Z`).getTime() + 365 * 24 * 3_600_000),
  )
  const reversed = new Set(
    (ledger?.lines ?? []).map((line) => line.reversesId).filter(Boolean) as string[],
  )

  const alreadyOn = new Set(lease.leaseTenants.map((lt) => lt.tenantId))
  const utilities = (lease.utilityResponsibility ?? {}) as Record<string, string>
  const baselinePhotos = lease.documents.filter(
    (doc) => doc.type === CONDITION_BASELINE_DOCUMENT_TYPE,
  )

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/leases"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← All leases
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {lease.property.name} — {lease.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {leaseStatusLabel(lease.status)}
          {lease.noticeGivenAt && ' · under notice'}
          {lease.origin === 'INHERITED' && ' · inherited at acquisition'}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Term</dt>
        <dd className="col-span-1 sm:col-span-2">
          {lease.startsOn.toISOString().slice(0, 10)}
          {lease.endsOn
            ? ` to ${lease.endsOn.toISOString().slice(0, 10)}`
            : ' — month-to-month, no end date'}
        </dd>
        <dt className="text-muted-foreground">Rent</dt>
        <dd className="col-span-1 sm:col-span-2">
          {formatCents(lease.rentCents)} due on day {lease.rentDueDay}
          {lease.mtmRentCents != null &&
            ` · ${formatCents(lease.mtmRentCents)} on rollover`}
        </dd>
        <dt className="text-muted-foreground">Deposit</dt>
        <dd className="col-span-1 sm:col-span-2">
          {/* SAYS WHOSE MONEY IT IS, not just how much (R-041, PAY-07). A
              security deposit is the tenant's, held on trust and owed back
              minus what can lawfully be proved - so a screen that shows it
              beside the rent as a bare number invites treating it as
              revenue, which is the mistake several states wrote escrow laws
              to prevent. */}
          {lease.depositArrangement === 'CASH' ? (
            <>
              {formatCents(lease.depositCents)}
              {lease.depositCents > 0 && (
                <span className="text-muted-foreground"> held on trust — not income</span>
              )}
            </>
          ) : lease.depositArrangement === 'SURETY_BOND' ? (
            'Surety bond — no cash held'
          ) : (
            'None'
          )}
          {lease.origin === 'INHERITED' && (
            <>
              {' · '}
              {depositTransferLabel(lease.depositTransferStatus)}
              {lease.depositTransferNote && ` (${lease.depositTransferNote})`}
            </>
          )}
          {depositRules.length > 0 && (
            <ul className="text-muted-foreground mt-1 list-disc pl-5 text-sm">
              {depositRules.map((obligation) => (
                <li key={obligation}>{obligation}</li>
              ))}
            </ul>
          )}
        </dd>
        {Object.keys(utilities).length > 0 && (
          <>
            <dt className="text-muted-foreground">Utilities</dt>
            <dd className="col-span-1 sm:col-span-2">
              {Object.entries(utilities)
                .filter(([, payer]) => payer !== 'NOT_APPLICABLE')
                .map(
                  ([utility, payer]) =>
                    `${UTILITY_LABELS[utility] ?? utility}: ${payer === 'TENANT' ? 'tenant' : 'landlord'}`,
                )
                .join(' · ')}
            </dd>
          </>
        )}
        {lease.noticeGivenAt && (
          <>
            <dt className="text-muted-foreground">Notice</dt>
            <dd className="col-span-1 sm:col-span-2">
              Given by {lease.noticeGivenBy === 'TENANT' ? 'the tenant' : 'us'} on{' '}
              {businessDate(lease.noticeGivenAt, lease.property.timezone)}
              {lease.noticeEffectiveOn &&
                ` — ends ${businessDate(lease.noticeEffectiveOn, lease.property.timezone)}`}
              {lease.noticeForwardingAddress && (
                <>
                  <br />
                  Forwarding address: {lease.noticeForwardingAddress}
                </>
              )}
              {lease.notices[0] && (
                <>
                  {' · '}
                  <Link href={`/notices/${lease.notices[0].id}`} className="underline underline-offset-2">
                    view non-renewal notice
                  </Link>
                </>
              )}
            </dd>
          </>
        )}
        {lease.terminationReason && (
          <>
            <dt className="text-muted-foreground">Terminated because</dt>
            <dd className="col-span-1 sm:col-span-2">{lease.terminationReason}</dd>
          </>
        )}
      </dl>

      {lease.origin === 'INHERITED' && (
        <IntakePanel
          gaps={gaps}
          canWrite={canWrite}
          resolveAction={resolveIntakeItem.bind(null, lease.id)}
        />
      )}

      {baselinePhotos.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-sm font-semibold">Condition as found</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {baselinePhotos.map((photo) => (
              <li key={photo.id}>
                <a
                  href={`/api/documents/${photo.id}/file`}
                  className="underline underline-offset-4"
                >
                  {photo.fileName}
                </a>
                <span className="text-muted-foreground text-xs">
                  {' · taken '}
                  {businessDate(photo.capturedAt ?? photo.createdAt, lease.property.timezone)}
                  {!photo.capturedAt && ' (upload date — no EXIF timestamp)'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <LedgerPanel
        balanceCents={ledger?.balanceCents ?? 0}
        lines={(ledger?.lines ?? []).map((line) => ({
          id: line.id,
          type: line.type,
          amountCents: line.amountCents,
          occurredAt: businessDate(line.occurredAt, lease.property.timezone),
          description: line.description,
          runningBalanceCents: line.runningBalanceCents,
          reversed: reversed.has(line.id),
        }))}
      />

      {/* Gated on `ledger` being readable at all - `leaseStatement` returns
          null outside the actor's scope, which is the same gate the panel
          above uses. The export shows nothing the panel does not; what it
          adds is a file that leaves the building, and that is audited. */}
      {ledger && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Statement of account
          </h2>
          <ExportStatementForm
            // Bound HERE, on the server, for the reason the status actions
            // above spell out - only a 'use server' export has an identity
            // the client can call back to.
            action={exportLedgerStatement.bind(null, lease.id)}
          />
        </section>
      )}

      <BillingPanel
        live={billingIsLive()}
        providerName={billingProviderName()}
        leaseId={lease.id}
        resync={resyncLease}
        payers={payers.map((payer) => ({
          id: payer.id,
          name: payer.tenant
            ? `${payer.tenant.firstName} ${payer.tenant.lastName}`
            : (payer.externalPayerName ?? 'Payer'),
          payerType: payer.payerType,
          portionCents: payer.portionCents,
          stripeCustomerId: payer.stripeCustomerId,
          stripeSubscriptionId: payer.stripeSubscriptionId,
        }))}
      />

      <PaymentHoldPanel
        canSet={holdDecision.allowed}
        payers={payers
          .filter((payer) => payer.active)
          .map((payer) => ({
            id: payer.id,
            name: payer.tenant
              ? `${payer.tenant.firstName} ${payer.tenant.lastName}`
              : (payer.externalPayerName ?? 'Payer'),
            blockOnline: payer.collectionPaused,
            blockPartial: payer.blockPartialPayments,
            certifiedFundsOnly: payer.certifiedFundsOnly,
            reason: payer.paymentHoldReason,
            // A real timestamp, so it is read in the PROPERTY's zone (R-101c).
            setAt: payer.paymentHoldSetAt
              ? businessDate(payer.paymentHoldSetAt, lease.property.timezone)
              : null,
            setByName: payer.paymentHoldSetBy?.name ?? null,
          }))}
        setHold={setPaymentHold}
      />

      <FeesPanel
        canWaive={waiveDecision.allowed}
        mfaRequired={!waiveDecision.allowed && waiveDecision.reason === 'mfa_required'}
        fees={fees.map((fee) => ({
          id: fee.id,
          type: fee.type,
          amountCents: fee.amountCents,
          description: fee.description,
          dueOn: fee.dueOn.toISOString().slice(0, 10),
          waivedAt: fee.waivedAt ? businessDate(fee.waivedAt, lease.property.timezone) : null,
          waiveReason: fee.waiveReason,
          waivedByName: fee.waivedBy?.name ?? null,
        }))}
        waive={waiveCharge}
      />

      <RecurringChargesPanel
        canWrite={canWrite}
        // `@db.Date` values, sliced off the ISO string rather than converted
        // through a timezone: they are calendar days and no zone may touch
        // them (the R-042 off-by-one, written down in CLAUDE.md).
        defaultStartsOn={lease.startsOn.toISOString().slice(0, 10)}
        charges={recurring.map((charge) => ({
          id: charge.id,
          type: charge.type,
          amountCents: charge.amountCents,
          description: charge.description,
          startsOn: charge.startsOn.toISOString().slice(0, 10),
          endsOn: charge.endsOn ? charge.endsOn.toISOString().slice(0, 10) : null,
          active: charge.active,
          live: charge.stripeSubscriptionItemId != null,
        }))}
        add={addRecurringCharge.bind(null, lease.id)}
        end={endRecurringCharge}
      />

      {canRecordPayment && payers.length > 0 && (ledger?.balanceCents ?? 0) > 0 && (
        <section
          aria-labelledby="offline-payment"
          className="flex flex-col gap-3 border-t pt-4"
        >
          <h2 id="offline-payment" className="text-lg font-semibold">
            Record a payment
          </h2>
          <p className="text-muted-foreground text-sm">
            A check, money order or cash handed over in person.
          </p>
          <OfflinePaymentForm
            // Bound server-side: a plain function cannot cross this boundary,
            // and `npm run build` does not catch the difference.
            action={recordOfflinePayment.bind(null, payers[0]!.id)}
            today={businessDate(new Date(), lease.property.timezone)}
            defaultAmountDollars={((ledger?.balanceCents ?? 0) / 100).toFixed(2)}
            payerName={
              payers[0]!.tenant
                ? `${payers[0]!.tenant.firstName} ${payers[0]!.tenant.lastName}`
                : (payers[0]!.externalPayerName ?? 'this payer')
            }
          />
        </section>
      )}

      <PartiesPanel
        canWrite={canWrite}
        tenants={lease.leaseTenants.map((lt) => ({
          id: lt.id,
          name: `${lt.tenant.firstName} ${lt.tenant.lastName}`,
          contact:
            [lt.tenant.email, lt.tenant.phone ? formatPhone(lt.tenant.phone) : null]
              .filter(Boolean)
              .join(' · ') || 'No contact details on file',
          isPrimary: lt.isPrimary,
        }))}
        guarantors={lease.guarantors.map((g) => ({
          id: g.id,
          name: `${g.firstName} ${g.lastName}`,
          contact:
            [g.email, g.phone ? formatPhone(g.phone) : null].filter(Boolean).join(' · ') ||
            'No contact details on file',
        }))}
        selectableTenants={tenants
          .filter((t) => !alreadyOn.has(t.id))
          .map((t) => ({
            id: t.id,
            label: `${t.firstName} ${t.lastName}${t.email ? ` (${t.email})` : ''}`,
          }))}
        addTenant={addLeaseTenant.bind(null, lease.id)}
        removeTenant={removeLeaseTenant.bind(null, lease.id)}
        addGuarantor={addGuarantor.bind(null, lease.id)}
      />

      <EsignPanel
        canExecute={execDecision.allowed}
        mfaRequired={!execDecision.allowed && execDecision.reason === 'mfa_required'}
        offerGenerate={lease.status === 'DRAFT'}
        envelope={
          currentEnvelope
            ? {
                status: currentEnvelope.status,
                addendumKeys: currentEnvelope.addendumKeys,
                draftDocumentId: currentEnvelope.draftDocumentId,
                executedDocumentId: currentEnvelope.executedDocumentId,
                sentAt: currentEnvelope.sentAt
                  ? businessDate(currentEnvelope.sentAt, lease.property.timezone)
                  : null,
                completedAt: currentEnvelope.completedAt
                  ? businessDate(currentEnvelope.completedAt, lease.property.timezone)
                  : null,
                voidedAt: currentEnvelope.voidedAt
                  ? businessDate(currentEnvelope.voidedAt, lease.property.timezone)
                  : null,
                signers: currentEnvelope.signers.map((signer) => ({
                  id: signer.id,
                  order: signer.order,
                  role: signer.role,
                  name: signer.name,
                  status: signer.status,
                  viewedAt: signer.viewedAt
                    ? businessDate(signer.viewedAt, lease.property.timezone)
                    : null,
                  signedAt: signer.signedAt
                    ? businessDate(signer.signedAt, lease.property.timezone)
                    : null,
                  signedName: signer.signedName,
                })),
              }
            : null
        }
        generateAction={generateAndSendLease.bind(null, lease.id)}
        voidAction={voidEnvelope.bind(null, lease.id)}
      />

      <RenewalPanel
        canOffer={canOfferRenewal}
        currentRentCents={lease.rentCents}
        marketRentCents={lease.unit.marketRentCents}
        defaultStartsOn={renewalDefaultStartsOn}
        defaultEndsOn={renewalDefaultEndsOn}
        predecessor={
          lease.renewedFrom
            ? { id: lease.renewedFrom.id, status: lease.renewedFrom.status, rentCents: lease.renewedFrom.rentCents }
            : null
        }
        successors={lease.renewalLeases.map((r) => ({
          id: r.id,
          status: r.status,
          startsOn: r.startsOn.toISOString().slice(0, 10),
          rentCents: r.rentCents,
        }))}
        action={offerRenewal.bind(null, lease.id)}
      />

      <RenterInsurancePanel
        canWrite={canWrite}
        current={
          lease.renterInsurancePolicies[0]
            ? {
                id: lease.renterInsurancePolicies[0].id,
                carrier: lease.renterInsurancePolicies[0].carrier,
                policyNumber: lease.renterInsurancePolicies[0].policyNumber,
                liabilityCents: lease.renterInsurancePolicies[0].liabilityCents,
                expiresOn: lease.renterInsurancePolicies[0].expiresOn
                  ? utcToBusinessDate(lease.renterInsurancePolicies[0].expiresOn)
                  : null,
                documentId: lease.renterInsurancePolicies[0].documentId,
                documentFileName: lease.renterInsurancePolicies[0].document?.fileName ?? null,
                createdAt: lease.renterInsurancePolicies[0].createdAt.toISOString(),
              }
            : null
        }
        action={recordRenterInsurance.bind(null, lease.id)}
      />

      <AccessCodesPanel
        leaseId={lease.id}
        canIssue={canIssue}
        depositCleared={depositCleared}
        codes={accessCodes.map((code) => ({
          id: code.id,
          type: code.type,
          label: code.label,
          issuedAt: code.issuedAt?.toISOString() ?? null,
        }))}
      />

      {canWrite && (
        <LifecyclePanel
          offers={offers}
          underNotice={lease.noticeGivenAt != null}
          noticeSummary={
            lease.noticeGivenAt
              ? `Notice was given by ${
                  lease.noticeGivenBy === 'TENANT' ? 'the tenant' : 'us'
                } on ${businessDate(lease.noticeGivenAt, lease.property.timezone)}. The tenancy is still running until ${
                  lease.noticeEffectiveOn
                    ? `it ends on ${businessDate(lease.noticeEffectiveOn, lease.property.timezone)}`
                    : 'it ends'
                }.`
              : null
          }
          recordNotice={recordLeaseNotice.bind(null, lease.id)}
        />
      )}

      {canWrite && (
        <section aria-labelledby="terms" className="flex flex-col gap-4 border-t pt-4">
          <h2 id="terms" className="text-lg font-semibold">
            Terms
          </h2>
          <LeaseForm
            action={updateLeaseTerms.bind(null, lease.id)}
            submitLabel="Save terms"
            defaults={{
              startsOn: lease.startsOn.toISOString().slice(0, 10),
              endsOn: lease.endsOn?.toISOString().slice(0, 10),
              rentDollars: String(lease.rentCents / 100),
              depositDollars: String(lease.depositCents / 100),
              depositArrangement: lease.depositArrangement,
              requireFullBalance: lease.requireFullBalance,
              // Undefined, not "0", when the lease is silent - re-rendering a
              // null as 0 would turn "no fee" into "expressly charges
              // nothing" on the next save (R-039a).
              nsfFeeDollars:
                lease.nsfFeeCents != null ? String(lease.nsfFeeCents / 100) : undefined,
              rentDueDay: String(lease.rentDueDay),
              isMonthToMonth: lease.isMonthToMonth,
              mtmRentDollars:
                lease.mtmRentCents != null ? String(lease.mtmRentCents / 100) : undefined,
              utilities,
            }}
          />
        </section>
      )}
    </div>
  )
}
