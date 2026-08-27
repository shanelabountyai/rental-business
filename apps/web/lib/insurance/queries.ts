import 'server-only'

import {
  claimPosition,
  lossOfRents,
  mitigationClock,
  type CauseOfLoss,
  type ClaimEventKind,
  type ClaimOutcome,
  type ClaimPosition,
  type LossOfRents,
  type MitigationClock,
  type PaymentCategory,
} from '@rental/core/insurance'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// Reads for insurance claims (RISK-07, R-089).

export interface ClaimPaymentView {
  id: string
  category: PaymentCategory
  amountCents: number
  receivedOn: string
  reference: string | null
  note: string | null
  recordedByName: string
}

export interface ClaimEventView {
  id: string
  kind: ClaimEventKind
  occurredAt: Date
  note: string
  documentId: string | null
  documentName: string | null
  recordedByName: string
}

export interface ClaimJobView {
  id: string
  scope: string
  status: string
  costCents: number
  capitalised: boolean
}

export interface ClaimView {
  id: string
  propertyId: string
  propertyName: string
  timezone: string
  policyId: string
  carrier: string
  policyNumber: string | null
  deductibleCents: number | null
  /// Whether the POLICY carries loss-of-rents cover. False is a real answer
  /// and the claim page says so rather than hiding the section.
  lossOfRentsCovered: boolean
  claimNumber: string | null
  cause: CauseOfLoss
  description: string
  incidentAt: Date
  mitigationStartedAt: Date | null
  reportedAt: Date | null
  adjusterName: string | null
  adjusterCompany: string | null
  adjusterPhone: string | null
  adjusterEmail: string | null
  status: 'OPEN' | 'CLOSED'
  outcome: ClaimOutcome | null
  outcomeNote: string | null
  openedAt: Date
  openedByName: string
  closedAt: Date | null
  jobs: ClaimJobView[]
  payments: ClaimPaymentView[]
  events: ClaimEventView[]
  documents: { id: string; fileName: string; contentType: string; capturedAt: Date | null }[]
  position: ClaimPosition
  mitigation: MitigationClock
  /// Null unless a loss-of-rents period has been recorded.
  lossOfRents: (LossOfRents & { fromOn: string; toOn: string; unitName: string }) | null
}

async function fetchClaim(id: string) {
  return prisma.insuranceClaim.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, name: true, timezone: true } },
      policy: {
        select: {
          id: true,
          carrier: true,
          policyNumber: true,
          deductibleCents: true,
          lossOfRents: true,
        },
      },
      openedBy: { select: { name: true } },
      lossOfRentsUnit: { select: { name: true, marketRentCents: true } },
      lossOfRentsLease: { select: { rentCents: true } },
      workOrders: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          scope: true,
          status: true,
          invoiceCents: true,
          actualLaborCents: true,
          actualMaterialsCents: true,
          capitalImprovement: { select: { id: true } },
        },
      },
      payments: {
        orderBy: { receivedOn: 'asc' },
        include: { recordedBy: { select: { name: true } } },
      },
      events: {
        orderBy: { occurredAt: 'asc' },
        include: {
          recordedBy: { select: { name: true } },
          document: { select: { id: true, fileName: true } },
        },
      },
      documents: { select: { id: true, fileName: true, contentType: true, capturedAt: true } },
    },
  })
}

type ClaimRow = NonNullable<Awaited<ReturnType<typeof fetchClaim>>>

function toView(row: ClaimRow, now: Date): ClaimView {
  const position = claimPosition({
    jobs: row.workOrders,
    payments: row.payments.map((p) => ({
      category: p.category as PaymentCategory,
      amountCents: p.amountCents,
    })),
    deductibleCents: row.policy.deductibleCents,
  })

  // ==========================================================================
  // THE RENT COMES FROM THE LEASE, OR FROM THE UNIT, AND NEVER FROM THE CLAIM.
  //
  // Which of the two is the better evidence is not a preference: a contract
  // rent under a live lease is what the tenancy was actually paying, and an
  // asking rent on an empty unit is an assertion a carrier will discount. So
  // the lease wins where there is one, and the SOURCE travels with the number
  // to the screen and into the claim file.
  // ==========================================================================
  let loss: ClaimView['lossOfRents'] = null
  if (row.lossOfRentsFromOn && row.lossOfRentsToOn && row.lossOfRentsUnit) {
    const monthly = row.lossOfRentsLease?.rentCents ?? row.lossOfRentsUnit.marketRentCents
    if (monthly != null) {
      const fromOn = utcToBusinessDate(row.lossOfRentsFromOn)
      const toOn = utcToBusinessDate(row.lossOfRentsToOn)
      loss = {
        ...lossOfRents(monthly, row.lossOfRentsLease ? 'lease' : 'unit_market', fromOn, toOn),
        fromOn,
        toOn,
        unitName: row.lossOfRentsUnit.name,
      }
    }
  }

  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    timezone: row.property.timezone,
    policyId: row.policyId,
    carrier: row.policy.carrier,
    policyNumber: row.policy.policyNumber,
    deductibleCents: row.policy.deductibleCents,
    lossOfRentsCovered: row.policy.lossOfRents,
    claimNumber: row.claimNumber,
    cause: row.cause as CauseOfLoss,
    description: row.description,
    incidentAt: row.incidentAt,
    mitigationStartedAt: row.mitigationStartedAt,
    reportedAt: row.reportedAt,
    adjusterName: row.adjusterName,
    adjusterCompany: row.adjusterCompany,
    adjusterPhone: row.adjusterPhone,
    adjusterEmail: row.adjusterEmail,
    status: row.status as 'OPEN' | 'CLOSED',
    outcome: row.outcome as ClaimOutcome | null,
    outcomeNote: row.outcomeNote,
    openedAt: row.openedAt,
    openedByName: row.openedBy.name,
    closedAt: row.closedAt,
    jobs: row.workOrders.map((job) => ({
      id: job.id,
      scope: job.scope,
      status: job.status,
      costCents: job.invoiceCents ?? (job.actualLaborCents ?? 0) + (job.actualMaterialsCents ?? 0),
      capitalised: job.capitalImprovement != null,
    })),
    payments: row.payments.map((payment) => ({
      id: payment.id,
      category: payment.category as PaymentCategory,
      amountCents: payment.amountCents,
      receivedOn: utcToBusinessDate(payment.receivedOn),
      reference: payment.reference,
      note: payment.note,
      recordedByName: payment.recordedBy.name,
    })),
    events: row.events.map((event) => ({
      id: event.id,
      kind: event.kind as ClaimEventKind,
      occurredAt: event.occurredAt,
      note: event.note,
      documentId: event.documentId,
      documentName: event.document?.fileName ?? null,
      recordedByName: event.recordedBy.name,
    })),
    documents: row.documents,
    position,
    mitigation: mitigationClock(
      row.incidentAt,
      row.mitigationStartedAt,
      row.cause as CauseOfLoss,
      now,
    ),
    lossOfRents: loss,
  }
}

/// One claim, scoped. Null rather than a throw for anything outside the
/// caller's scope, so the page answers 404 rather than 403 (ROLE-01).
export async function getClaim(id: string, scope: ResolvedScope): Promise<ClaimView | null> {
  if (scope.propertyIds.length === 0) return null
  const row = await fetchClaim(id)
  if (!row || !scope.propertyIds.includes(row.propertyId)) return null
  return toView(row, new Date())
}

export interface ClaimSummary {
  id: string
  propertyName: string
  /// The property's own zone. The register spans properties in different
  /// states, so a single zone for the page would misdate half the rows.
  timezone: string
  claimNumber: string | null
  cause: CauseOfLoss
  status: 'OPEN' | 'CLOSED'
  outcome: ClaimOutcome | null
  incidentAt: Date
  paidCents: number
  /// True only where a water loss is past the mitigation target with nothing
  /// recorded as started. The register sorts these first.
  mitigationUrgent: boolean
}

/**
 * Open claims first, and inside that the ones nobody has started mitigating.
 *
 * A claim's failure mode is the same as a violation case's: not being wrong,
 * being forgotten. The difference is that the forgetting has a deadline
 * attached — a water loss nobody has started drying is losing value by the
 * hour, and it is the one row that has to be at the top.
 */
export async function listClaims(scope: ResolvedScope): Promise<ClaimSummary[]> {
  if (scope.propertyIds.length === 0) return []
  const now = new Date()
  const rows = await prisma.insuranceClaim.findMany({
    where: { propertyId: { in: scope.propertyIds } },
    orderBy: [{ status: 'asc' }, { incidentAt: 'desc' }],
    select: {
      id: true,
      claimNumber: true,
      cause: true,
      status: true,
      outcome: true,
      incidentAt: true,
      mitigationStartedAt: true,
      property: { select: { name: true, timezone: true } },
      payments: { select: { amountCents: true } },
    },
  })

  const summaries = rows.map((row) => ({
    id: row.id,
    propertyName: row.property.name,
    timezone: row.property.timezone,
    claimNumber: row.claimNumber,
    cause: row.cause as CauseOfLoss,
    status: row.status as 'OPEN' | 'CLOSED',
    outcome: row.outcome as ClaimOutcome | null,
    incidentAt: row.incidentAt,
    paidCents: row.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
    mitigationUrgent:
      row.status === 'OPEN' &&
      mitigationClock(row.incidentAt, row.mitigationStartedAt, row.cause as CauseOfLoss, now).urgent,
  }))

  return summaries.sort((a, b) => Number(b.mitigationUrgent) - Number(a.mitigationUrgent))
}

/** The claims on one property, for the property page's panel. */
export async function claimsForProperty(propertyId: string): Promise<ClaimSummary[]> {
  return listClaims({ propertyIds: [propertyId] } as ResolvedScope)
}

/** Policies on a property, for the open-a-claim picker. */
export async function policiesForProperty(propertyId: string) {
  return prisma.insurancePolicy.findMany({
    where: { propertyId },
    orderBy: { renewsOn: 'desc' },
    select: {
      id: true,
      carrier: true,
      policyNumber: true,
      deductibleCents: true,
      lossOfRents: true,
    },
  })
}
