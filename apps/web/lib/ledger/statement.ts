'use server'

import { createHash } from 'node:crypto'
import type { StatementLine } from '@rental/core/ledger'
import { statementBlocks, statementForPeriod } from '@rental/core/ledger'
import {
  businessDate,
  friendlyDate,
  friendlyTimestamp,
  wallClockToUtc,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { appendPdfs, renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// The database half of the court-ready statement (PAY-09, R-052). The
// arithmetic is `packages/core/ledger/balance.ts` and what the page says is
// `statement-document.ts`; this pulls the rows and appends the provider's own
// invoices to the result (D-50).

export interface FormState {
  error?: string
  notice?: string
  documentId?: string
}

/// A `YYYY-MM-DD` from an `<input type="date">`, or null for an open end.
/// Anything else is treated as absent rather than rejected: a malformed date
/// should widen the statement, never silently narrow it to a window nobody
/// asked for.
function optionalDate(formData: FormData, name: string): string | null {
  const value = formData.get(name)
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : null
}

/**
 * Produces and archives a statement of account for a lease and period.
 *
 * NOT IDEMPOTENT, for the same reason the transcript is not: a statement is a
 * claim about what was owed on a date, and the ledger keeps moving after it.
 * Each export is separately archived so "the statement we filed in March"
 * survives the balance changing in April.
 */
export async function exportLedgerStatement(
  leaseId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const fromDate = optionalDate(formData, 'fromDate')
  const toDate = optionalDate(formData, 'toDate')
  if (fromDate && toDate && fromDate > toDate) {
    // Compared as strings, which is exact for `YYYY-MM-DD` and needs no
    // timezone - the two dates are calendar days, and no zone may touch them.
    return { error: 'The start of the period must not be after the end.' }
  }

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          legalEntityId: true,
          timezone: true,
          addressLine1: true,
          active: true,
        },
      },
      unit: { select: { name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  })
  if (!lease) return { error: 'That lease no longer exists.' }

  const actor = await requirePermission('ledger.read', propertyResource(lease.property))
  const zone = lease.property.timezone

  // EVERY entry, not just the window's - `statementForPeriod` needs the whole
  // history to carry a balance forward into the period. See its own comment
  // for why filtering first produces a document that is internally consistent
  // and materially false.
  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId: lease.id },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      description: true,
      reversesId: true,
      stripeObjectId: true,
    },
  })

  // A calendar day converted to the property's own midnight, not the
  // server's (D-3). `toDate` is inclusive, so the window closes at the END of
  // that local day - a statement "to 31 March" that stopped at 31 March
  // 00:00 would silently drop everything that happened on its last day.
  const from = fromDate ? localDayStart(fromDate, zone) : null
  const to = toDate ? localDayEnd(toDate, zone) : null

  const period = statementForPeriod(rows, from, to)

  // Which Stripe invoice backs which line. Held as a map rather than being
  // read off the line inside core, because `StatementLine` is the pure
  // arithmetic shape and has no business knowing about a payment provider.
  const invoiceByEntryId = new Map(
    rows
      .filter((row) => row.stripeObjectId?.startsWith('in_'))
      .map((row) => [row.id, row.stripeObjectId!]),
  )
  const invoiceRefOf = (line: StatementLine) => invoiceByEntryId.get(line.id) ?? null

  // Distinct, and in the order they appear on the statement, so the appended
  // invoices run in the same order as the lines that cite them.
  const citedInvoiceIds = [
    ...new Set(period.lines.map(invoiceRefOf).filter((id): id is string => id !== null)),
  ]

  const provider = getBillingProvider()
  const fetched = await Promise.all(
    citedInvoiceIds.map(async (id) => {
      try {
        return { id, bytes: await provider.getInvoicePdf(id) }
      } catch {
        // A provider error is a missing attachment, not a failed export. The
        // statement says which ones are missing.
        return { id, bytes: null }
      }
    }),
  )

  const available = fetched.filter(
    (row): row is { id: string; bytes: Uint8Array } => row.bytes !== null,
  )
  const missing = fetched.filter((row) => row.bytes === null).map((row) => row.id)

  const generatedAt = new Date()
  const staff = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { name: true },
  })

  // One place that builds the document, parameterized by the only thing that
  // can change between the two renders below: which invoices actually made it
  // in. Duplicating the fact-building instead is how the two copies drift and
  // the second one silently prints a stale balance.
  const render = (attachedInvoiceIds: string[], unattachedInvoiceIds: string[]) =>
    renderBlocksPdf(
      statementBlocks(
        {
          propertyName: lease.property.name,
          addressLine1: lease.property.addressLine1,
          unitName: lease.unit.name,
          tenantNames: lease.leaseTenants.map(
            (lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`,
          ),
          periodFrom: from ? friendlyDate(from, zone) : null,
          periodTo: to ? friendlyDate(to, zone) : null,
          timezone: zone,
          generatedAt: friendlyTimestamp(generatedAt, zone),
          generatedBy: staff?.name ?? 'Not recorded',
          formatDate: (instant) => friendlyDate(instant, zone),
          openingBalanceCents: period.openingBalanceCents,
          closingBalanceCents: period.closingBalanceCents,
          lines: period.lines,
          attachedInvoiceIds,
          unattachedInvoiceIds,
        },
        invoiceRefOf,
      ),
      { title: `Statement of account — ${lease.property.name}` },
    )

  const appended = await appendPdfs(
    await render(
      available.map((row) => row.id),
      [...missing],
    ),
    available.map((row) => ({ label: row.id, bytes: row.bytes })),
  )

  // AN INVOICE THAT ARRIVED BUT WOULD NOT PARSE IS AS MISSING AS ONE THAT
  // NEVER ARRIVED - and the page has already been rendered claiming it was
  // attached. Rendering a second time with the corrected lists costs one
  // extra pass and keeps the attachment section true; shipping the first
  // render would produce a document that names an attachment it does not
  // contain, which is precisely the false claim that section exists to
  // prevent.
  let bytes = appended.bytes
  let unattached = [...missing]
  if (appended.failed.length > 0) {
    const failed = new Set(appended.failed)
    const parsed = available.filter((row) => !failed.has(row.id))
    unattached = [...missing, ...appended.failed]
    const corrected = await appendPdfs(
      await render(
        parsed.map((row) => row.id),
        unattached,
      ),
      parsed.map((row) => ({ label: row.id, bytes: row.bytes })),
    )
    bytes = corrected.bytes
  }

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `statement-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(lease.propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        // No `tenantId`, same call as the transcript: a packet assembled for
        // a dispute with this tenant must not appear in their own portal.
        type: 'LEDGER_STATEMENT',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'ledger.statement_exported',
        entityType: 'Lease',
        entityId: lease.id,
        propertyId: lease.propertyId,
        after: {
          documentId: document.id,
          periodFrom: fromDate,
          periodTo: toDate,
          lineCount: period.lines.length,
          closingBalanceCents: period.closingBalanceCents,
          // The TRUE outcome, not the hoped-for one: `unattached` includes any
          // invoice that arrived but would not parse. The audit row and the
          // document must agree about what is in the file.
          attachedInvoiceIds: available
            .filter((row) => !unattached.includes(row.id))
            .map((row) => row.id),
          unattachedInvoiceIds: unattached,
          sha256,
        },
      },
      tx,
    )
    return document.id
  })

  const note =
    unattached.length > 0
      ? `Statement produced. ${unattached.length} cited ${unattached.length === 1 ? 'invoice' : 'invoices'} could not be attached and ${unattached.length === 1 ? 'is' : 'are'} named on the statement.`
      : 'Statement produced.'
  return { notice: note, documentId }
}

/// A property-local calendar day's first instant.
function localDayStart(date: string, zone: string): Date {
  return wallClockToUtc(`${date}T00:00`, zone)
}

/// A property-local calendar day's LAST instant. Inclusive windows are what a
/// person means by "to 31 March"; see the caller's own comment. 23:59 plus
/// 59.999s rather than the next day's midnight, so a leap second or a DST
/// jump cannot pull the boundary into the following day.
function localDayEnd(date: string, zone: string): Date {
  return new Date(wallClockToUtc(`${date}T23:59`, zone).getTime() + 59_999)
}
