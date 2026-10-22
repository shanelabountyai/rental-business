import 'server-only'

import { parseLeaseDate } from '@rental/core/leases'
import { validateDepositAmount } from '@rental/core/ledger'
import { can, type Actor } from '@rental/core/rbac'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource } from '@/lib/auth/guard.ts'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'

/**
 * Approve converts the household to a lease draft (R-270, PRD 08 C5/M3.2).
 *
 * A DRAFT in the existing lease flow, nothing more: the same row `createLease`
 * writes, with the applicants turned into Tenant rows on it (the lead as
 * primary) the way R-090's party change turns an incoming applicant into one.
 * Terms come off the listing - rent, deposit, the unit - and the start date is
 * the listing's available date or today, whichever is later. No end date: a
 * fixed term's length is the owner's call, and `activationGaps` already
 * refuses to activate a lease that has not been given one. Everything after
 * this - terms, template, e-sign - is R-063's flow, unchanged.
 *
 * Returns why it did NOT open one, rather than throwing: the decision that
 * led here is recorded and must stand whatever happens to the draft. Three
 * refusals, each a case where a silent draft would be worse than none - the
 * decider cannot write leases, the listing's deposit is over the
 * jurisdiction's cap (`createLease` refuses the same thing, D-4), or the unit
 * already has a live tenancy.
 */
export async function openLeaseDraft(
  applicationId: string,
  actor: Actor,
): Promise<{ leaseId: string } | { skipped: string }> {
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: {
      property: true,
      listing: true,
      applicants: { orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }] },
      leaseDraft: { select: { id: true } },
    },
  })
  if (application.leaseDraft) return { leaseId: application.leaseDraft.id }
  const { property, listing } = application

  if (!can(actor, 'lease.write', propertyResource(property)).allowed) {
    return { skipped: 'whoever recorded the decision cannot write leases' }
  }

  const rule = await rulesForConfigured({ state: property.state, county: property.county }, new Date())
  const depositCents = listing.depositCents ?? 0
  if (
    rule &&
    validateDepositAmount({ depositCents, rentCents: listing.rentCents, arrangement: 'CASH', rule })
      .length > 0
  ) {
    return { skipped: "the listing's deposit is over this jurisdiction's cap" }
  }

  const live = await prisma.lease.count({
    where: { unitId: listing.unitId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
  })
  if (live > 0) return { skipped: 'the unit already has a live tenancy' }

  const today = businessDate(new Date(), property.timezone)
  const available = utcToBusinessDate(listing.availableOn)
  const startsOn = available > today ? available : today

  try {
    const lease = await prisma.$transaction(async (tx) => {
      const created = await tx.lease.create({
        data: {
          propertyId: property.id,
          unitId: listing.unitId,
          applicationId,
          status: 'DRAFT',
          origin: 'APPLICATION',
          startsOn: parseLeaseDate(startsOn)!,
          rentCents: listing.rentCents,
          depositCents,
          depositArrangement: 'CASH',
        },
      })
      const tenantIds: string[] = []
      for (const [index, a] of application.applicants.entries()) {
        const tenant = await tx.tenant.create({
          data: { firstName: a.firstName, lastName: a.lastName, email: a.email, phone: a.phone },
        })
        await tx.leaseTenant.create({
          data: { leaseId: created.id, tenantId: tenant.id, isPrimary: index === 0 },
        })
        tenantIds.push(tenant.id)
      }
      await audit(
        {
          action: 'lease.created',
          entityType: 'Lease',
          entityId: created.id,
          propertyId: property.id,
          after: {
            origin: 'APPLICATION',
            applicationId,
            unitId: listing.unitId,
            startsOn,
            rentCents: listing.rentCents,
            depositCents,
            tenantIds,
          },
        },
        tx,
      )
      return created
    })
    return { leaseId: lease.id }
  } catch (error) {
    // `Lease.applicationId` is unique: a concurrent approval got there first.
    const existing = await prisma.lease.findUnique({ where: { applicationId }, select: { id: true } })
    if (existing) return { leaseId: existing.id }
    throw error
  }
}
