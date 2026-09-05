import 'server-only'

import type { HandoffAccessCode, HandoffLease, HandoffUnit, HandoffVendorJob, HandoffWarranty } from '@rental/core/property'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { depositLiabilityCents } from '@rental/core/ledger'
import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { getFilingCabinet } from '@/lib/filing-cabinet/queries.ts'
import { leaseBalanceCents } from '@/lib/ledger/queries.ts'
import { getPropertyDetail } from '@/lib/properties/queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// The reads behind the handoff packet (DOC-06, RISK-09; R-092).
//
// ==========================================================================
// THIS FILE IS WHERE THE PACKET'S EXCLUSIONS ARE ACTUALLY ENFORCED, and its
// own test greps it: `AccessCode.sealedCode` is never selected, and
// `WorkOrder.restrictedPartyNote` is never selected. Both are one word away
// from being in a file that gets emailed to a buyer's solicitor.
//
//   * `sealedCode`, because R-005 made every reveal an individually audited
//     act (`accesscode.reveal`) and a bulk print would collapse all of them
//     into one line.
//   * `restrictedPartyNote`, because R-091 puts a household member's name in
//     that column for a locksmith standing at a door, and D-107 is what says
//     it goes no further. The JOB itself is here, correctly - it is an
//     ordinary re-key, and D-109 is explicit that a case's consequences
//     cannot be hidden.
//
// Nothing here imports `lib/confidential/`, which is the module whose own
// header says nothing else ever should.
// ==========================================================================

export interface HandoffSource {
  propertyId: string
  legalEntityId: string
  propertyName: string
  addressLine1: string
  addressLine2: string | null
  city: string
  state: string
  postalCode: string
  timezone: string
  entityName: string
  propertyType: string
  yearBuilt: number | null
  units: HandoffUnit[]
  leases: HandoffLease[]
  accessCodes: HandoffAccessCode[]
  vendorJobs: HandoffVendorJob[]
  warranties: HandoffWarranty[]
  hoa: { association: string; hasRentalCap: boolean; rentalCapPolicy: string | null } | null
}

/// A tenancy the buyer is actually taking on. DRAFT and ENDED leases are out:
/// a packet listing a lease that never started, or one that ended two years
/// ago, invites a buyer to price a tenancy that does not exist.
const RUNNING = ['ACTIVE', 'MONTH_TO_MONTH'] as const

export async function handoffSource(
  propertyId: string,
  scope: ResolvedScope,
): Promise<HandoffSource | null> {
  const property = await getPropertyDetail(propertyId, scope)
  if (!property) return null

  const [units, leases, codes, jobs, cabinet, hoa] = await Promise.all([
    prisma.unit.findMany({
      where: { propertyId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, status: true, bedrooms: true, bathrooms: true },
    }),
    prisma.lease.findMany({
      where: { propertyId, status: { in: [...RUNNING] } },
      orderBy: { startsOn: 'asc' },
      select: {
        id: true,
        status: true,
        startsOn: true,
        endsOn: true,
        isMonthToMonth: true,
        rentCents: true,
        rentDueDay: true,
        noticeEffectiveOn: true,
        unit: { select: { name: true } },
        leaseTenants: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { tenant: { select: { firstName: true, lastName: true } } },
        },
        deposits: {
          select: {
            heldCents: true,
            appliedCents: true,
            refundedCents: true,
            dispositionSentAt: true,
            refundPaidOn: true,
          },
        },
      },
    }),
    // Current codes only - `effectiveTo: null` is R-005's own notion of "on
    // file now", the same one R-091 retires against. NO `sealedCode`.
    prisma.accessCode.findMany({
      where: { unit: { propertyId }, effectiveTo: null },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        type: true,
        label: true,
        createdAt: true,
        unit: { select: { name: true } },
      },
    }),
    // Completed work, newest first. NO `restrictedPartyNote`.
    prisma.workOrder.findMany({
      where: { propertyId, completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      select: {
        completedAt: true,
        scope: true,
        actualLaborCents: true,
        actualMaterialsCents: true,
        invoiceCents: true,
        vendor: { select: { name: true } },
      },
    }),
    getFilingCabinet(propertyId, scope),
    prisma.hoaInfo.findUnique({
      where: { propertyId },
      select: { name: true, hasRentalCap: true, rentalCapPolicy: true },
    }),
  ])

  // One query per tenancy rather than one aggregate: `leaseBalanceCents` is
  // the single place a balance is computed (it reads the append-only ledger
  // projection), and a second implementation here would be a second answer to
  // "what do they owe" - the one question a buyer will check.
  const balances = await Promise.all(leases.map((lease) => leaseBalanceCents(lease.id)))

  return {
    propertyId,
    legalEntityId: property.legalEntityId,
    propertyName: property.name,
    addressLine1: property.addressLine1,
    addressLine2: property.addressLine2,
    city: property.city,
    state: property.state,
    postalCode: property.postalCode,
    timezone: property.timezone,
    entityName: property.legalEntity.name,
    propertyType: property.propertyType,
    yearBuilt: property.yearBuilt,
    units: units.map((unit) => ({
      name: unit.name,
      status: unit.status,
      bedrooms: unit.bedrooms,
      // Prisma Decimal, and a display value rather than money - D-3's
      // integer-cents rule is about money, and half a bathroom is real.
      bathrooms: unit.bathrooms == null ? null : Number(unit.bathrooms),
    })),
    leases: leases.map((lease, index) => ({
      leaseId: lease.id,
      unitName: lease.unit.name,
      tenantNames: lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`),
      status: lease.status,
      startsOn: utcToBusinessDate(lease.startsOn),
      endsOn: lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
      isMonthToMonth: lease.isMonthToMonth,
      rentCents: lease.rentCents,
      rentDueDay: lease.rentDueDay,
      // What is STILL held, not what was ever taken. A deposit partly applied
      // to a previous claim transfers at the remainder, and printing the
      // gross would hand the buyer a liability that is bigger than the money.
      // R-170: an unpaid refund transfers too — the buyer inherits the
      // obligation, and the letter is not the payment.
      depositHeldCents: lease.deposits.reduce(
        (sum, deposit) => sum + depositLiabilityCents(deposit),
        0,
      ),
      balanceCents: balances[index] ?? 0,
      noticeEffectiveOn: lease.noticeEffectiveOn
        ? utcToBusinessDate(lease.noticeEffectiveOn)
        : null,
    })),
    accessCodes: codes.map((code) => ({
      unitName: code.unit.name,
      type: code.type,
      label: code.label,
      issuedOn: utcToBusinessDate(code.createdAt),
    })),
    vendorJobs: jobs.map((job) => ({
      completedOn: job.completedAt ? utcToBusinessDate(job.completedAt) : null,
      // A job done in-house or by a vendor since retired still happened, and
      // a gap in the maintenance history reads as neglect rather than as a
      // missing join.
      vendorName: job.vendor?.name ?? 'Not recorded',
      scope: job.scope,
      costCents: jobCostCents(job),
    })),
    warranties: (cabinet?.warranties ?? []).map((warranty) => ({
      category: warranty.category,
      provider: warranty.provider,
      coverageSummary: warranty.coverageSummary,
      expiresOn: warranty.expiresOn ? utcToBusinessDate(warranty.expiresOn) : null,
    })),
    hoa: hoa
      ? {
          association: hoa.name ?? 'Association name not recorded',
          hasRentalCap: hoa.hasRentalCap,
          rentalCapPolicy: hoa.rentalCapPolicy,
        }
      : null,
  }
}
