import 'server-only'

import { balanceCents } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import {
  businessDate,
  dueDateOnOrAfter,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
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
  leaseId: string
  /// EXACTLY ONE OF THESE, and the one that is set is the person the message
  /// is addressed to (R-179). A rent chase reaches every party who can pay —
  /// a roommate holding the money and any guarantor on the hook for it — and
  /// a guarantor is not a `Tenant` row, so "the recipient" cannot be a
  /// tenantId any more.
  ///
  /// BOTH ARE SCOPED TO THE LEASE BY THE QUERY BELOW, not by the caller: an
  /// id that does not belong to this tenancy resolves to no party and the
  /// render returns null, which the send path already treats as "do not
  /// send". That is the property that makes it safe for an id to arrive from
  /// a form.
  tenantId?: string | null
  guarantorId?: string | null
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
      // `?? ''` rather than a conditional include: an empty string matches no
      // cuid, so the unset side comes back empty and the set side is still
      // constrained to THIS lease. One query either way.
      leaseTenants: {
        where: { tenantId: ref.tenantId ?? '' },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
      guarantors: {
        where: { id: ref.guarantorId ?? '' },
        select: { firstName: true, lastName: true },
      },
    },
  })
  if (!lease) return null

  // The party this message is addressed to, whichever kind it is. Null when
  // the id names somebody who is not on this lease at all — see `TenancyRef`.
  const party = lease.leaseTenants[0]?.tenant ?? lease.guarantors[0] ?? null
  if (!party) return null

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
    // THE RECIPIENT'S OWN NAME, whether they are a tenant or a guarantor.
    // The catalogue calls these `tenant.*` and they stay called that — the
    // field names are in every template an operator has already written, and
    // renaming them would blank a merge field mid-sentence. What they mean is
    // "the person this copy is addressed to", which is what a salutation
    // wants: a guarantor greeted by the tenant's first name is a message that
    // reads as sent to the wrong person.
    'tenant.first_name': party.firstName,
    'tenant.last_name': party.lastName,
    'tenant.full_name': `${party.firstName} ${party.lastName}`,
    'property.name': lease.property.name,
    'property.address': lease.property.addressLine1,
    'unit.name': lease.unit.name,
    'lease.rent': formatCents(lease.rentCents),
    // `@db.Date` columns. `utcToBusinessDate` is the reader for a calendar
    // day; putting one through a timezone is the R-042 bug in a new place.
    //
    // AND `friendlyBusinessDate` ON TOP OF IT, because this is the renderer
    // (D-153, D-198). A merge value goes into a tenant's email and into the
    // append-only `Message` trail exactly as written here, so a raw
    // `2026-10-01` is a machine identifier posted to a person. The preview
    // panel cannot catch it: it flags a field with NOTHING behind it, and a
    // field with the wrong FORMAT behind it looks fine to it.
    'lease.starts_on': friendlyBusinessDate(utcToBusinessDate(lease.startsOn)),
    'lease.ends_on': lease.endsOn ? friendlyBusinessDate(utcToBusinessDate(lease.endsOn)) : null,
    // NEGATIVE MEANS CREDIT, and a message must never tell a tenant in credit
    // that they owe a negative amount. Null instead, so the send path refuses
    // rather than sending nonsense — see `renderTemplate`'s `missing`.
    'balance.total': owed > 0 ? formatCents(owed) : null,
    'balance.due_on': friendlyBusinessDate(dueDateOnOrAfter(today, lease.rentDueDay)),
    today: friendlyBusinessDate(today),
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
