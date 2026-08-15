import 'server-only'

import { balanceCents } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { businessDate, dueDateOnOrAfter, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'

// Turning a real tenancy into merge-field values (COMM-03, R-049).
//
// ==========================================================================
// ONE RESOLVER FOR PREVIEW AND FOR SEND, and that is the point of the file.
//
// COMM-03 asks for "preview before send". A preview built from different code
// than the send is not a preview — it is a second implementation that agrees
// with the first until the day it does not, and the day it does not is the
// day a thousand tenants get a message the PM never saw. So the preview
// screen and the send path call THIS, and the only difference between them is
// which tenancy the ids point at.
//
// EVERY VALUE IS A STRING, already formatted. Money is formatted here rather
// than in the template because a template cannot be trusted with cents (it is
// a textarea), and dates are read in the PROPERTY's timezone rather than the
// server's for the reason R-101c exists.
// ==========================================================================

export interface TenancyRef {
  tenantId: string
  leaseId: string
}

/// The tenancy a template is being rendered against, plus who it goes to.
export interface TemplateAudience extends TenancyRef {
  tenantName: string
  preferredLocale: string | null
  email: string | null
  phone: string | null
}

export const COMPANY_NAME = 'Rental Operations'

export async function templateValues(
  ref: TenancyRef,
): Promise<Record<string, string | null> | null> {
  const lease = await prisma.lease.findUnique({
    where: { id: ref.leaseId },
    select: {
      startsOn: true,
      endsOn: true,
      rentCents: true,
      rentDueDay: true,
      property: { select: { name: true, addressLine1: true, timezone: true } },
      unit: { select: { name: true } },
      leaseTenants: {
        where: { tenantId: ref.tenantId },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  })
  if (!lease) return null

  const tenant = lease.leaseTenants[0]?.tenant
  if (!tenant) return null

  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId: ref.leaseId },
    select: {
      id: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      description: true,
      reversesId: true,
    },
  })
  const owed = balanceCents(rows)

  // The PROPERTY's calendar day, not the server's (D-3). A reminder that says
  // "today" and names yesterday is a reminder nobody trusts again.
  const today = businessDate(new Date(), lease.property.timezone)

  return {
    'tenant.first_name': tenant.firstName,
    'tenant.last_name': tenant.lastName,
    'tenant.full_name': `${tenant.firstName} ${tenant.lastName}`,
    'property.name': lease.property.name,
    'property.address': lease.property.addressLine1,
    'unit.name': lease.unit.name,
    'lease.rent': formatCents(lease.rentCents),
    // `@db.Date` columns. `utcToBusinessDate` is the reader for a calendar
    // day; putting one through a timezone is the R-042 bug in a new place.
    'lease.starts_on': utcToBusinessDate(lease.startsOn),
    'lease.ends_on': lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
    // NEGATIVE MEANS CREDIT, and a message must never tell a tenant in credit
    // that they owe a negative amount. Null instead, so the send path refuses
    // rather than sending nonsense — see `renderTemplate`'s `missing`.
    'balance.total': owed > 0 ? formatCents(owed) : null,
    'balance.due_on': dueDateOnOrAfter(today, lease.rentDueDay),
    today,
    'company.name': COMPANY_NAME,
    // No per-property contact number exists on Property yet, so this is the
    // one merge field with nothing behind it. Null rather than a placeholder:
    // `renderTemplate` leaves the token visible and the send path refuses,
    // which is the honest outcome for a field the product cannot fill. R-081's
    // property contact details is where it gets a value.
    'company.phone': null,
  }
}

/**
 * A tenancy to preview against — the most recently started live lease with a
 * tenant on it.
 *
 * PREVIEW USES REAL DATA, not the catalogue's example values. The examples
 * exist to label the fields in the editor; they would make a preview that
 * always looks perfect, which is the opposite of what a preview is for. A PM
 * needs to see that `{{lease.ends_on}}` comes out blank on their
 * month-to-month tenancies BEFORE they send to four hundred of them.
 */
export async function previewTenancy(
  propertyIds: readonly string[] | null,
): Promise<TemplateAudience | null> {
  const lease = await prisma.lease.findFirst({
    where: {
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      ...(propertyIds ? { propertyId: { in: [...propertyIds] } } : {}),
      leaseTenants: { some: {} },
    },
    orderBy: { startsOn: 'desc' },
    select: {
      id: true,
      leaseTenants: {
        take: 1,
        select: {
          tenant: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              preferredLocale: true,
            },
          },
        },
      },
    },
  })
  const tenant = lease?.leaseTenants[0]?.tenant
  if (!lease || !tenant) return null

  return {
    tenantId: tenant.id,
    leaseId: lease.id,
    tenantName: `${tenant.firstName} ${tenant.lastName}`,
    preferredLocale: tenant.preferredLocale,
    email: tenant.email,
    phone: tenant.phone,
  }
}
