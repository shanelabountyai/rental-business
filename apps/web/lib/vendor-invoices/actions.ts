'use server'

import { businessDateToUtc } from '@rental/core/scheduling'
import { type SplitInvoiceInput, validateSplitInvoice } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

// Writes for split vendor invoices (PAY-10, R-082).
//
// The invoice and its lines land in ONE transaction. A half-entered invoice is
// worse than none: the splits are required to sum to the vendor's total, and a
// partially-written invoice would sit in the database permanently violating
// the one rule that makes it reconcilable.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(violations: readonly { field: string; message: string }[]): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Whole dollars in, integer cents out. Null for a blank so validation can
/// tell "not filled in" from "zero", which are different mistakes.
function cents(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  if (!raw) return null
  const dollars = Number(raw)
  if (Number.isNaN(dollars)) return Number.NaN
  return Math.round(dollars * 100)
}

/// How many split rows the form submitted. Read off the posted keys rather
/// than a hidden count field, so a client that added rows and one that did
/// not are handled identically.
function splitRowCount(formData: FormData): number {
  let highest = -1
  for (const key of formData.keys()) {
    const match = /^splits\.(\d+)\./.exec(key)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

export async function recordVendorInvoice(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor } = await requireScope('vendor.write')
  const scope = await currentScope(actor)

  const rows = Array.from({ length: splitRowCount(formData) }, (_, index) => ({
    propertyId: str(formData, `splits.${index}.propertyId`),
    category: str(formData, `splits.${index}.category`),
    amountCents: cents(formData, `splits.${index}.amountDollars`),
    workOrderId: str(formData, `splits.${index}.workOrderId`) || null,
    description: str(formData, `splits.${index}.description`) || null,
  }))

  // A blank row is a row the form offered and nobody used - dropped before
  // validation, not reported as five errors.
  const splits = rows.filter(
    (row) => row.propertyId || row.amountCents != null || row.workOrderId || row.description,
  )

  const input: SplitInvoiceInput = {
    legalEntityId: str(formData, 'legalEntityId'),
    vendorId: str(formData, 'vendorId'),
    invoiceNumber: str(formData, 'invoiceNumber') || null,
    totalCents: cents(formData, 'totalDollars'),
    invoicedOn: str(formData, 'invoicedOn'),
    paidOn: str(formData, 'paidOn') || null,
    paymentMethod: str(formData, 'paymentMethod') || null,
    notes: str(formData, 'notes') || null,
    splits,
  }

  const violations = validateSplitInvoice(input)
  if (violations.length > 0) return violationsToState(violations)

  // Scope, and the entity boundary. A split naming a property this actor
  // cannot see, or one belonging to a different entity than the invoice, is
  // money that would leave one set of books without arriving on any other -
  // and the tax export runs strictly per entity.
  const inScope = new Map(scope.availableProperties.map((property) => [property.id, property]))
  const scopeViolations: { field: string; message: string }[] = []
  splits.forEach((split, index) => {
    const property = inScope.get(split.propertyId)
    if (!property) {
      scopeViolations.push({
        field: `splits.${index}.propertyId`,
        message: 'No property you can see has that ID.',
      })
      return
    }
    if (property.legalEntityId !== input.legalEntityId) {
      scopeViolations.push({
        field: `splits.${index}.propertyId`,
        message: `${property.name} belongs to a different legal entity than this invoice.`,
      })
    }
  })
  if (scopeViolations.length > 0) return violationsToState(scopeViolations)

  // Each named work order must be on the same property as its line, and must
  // not already be capitalised. Both are double-count guards: a job on the
  // wrong house would remove its cost from that house's repairs, and a job
  // whose cost is already on the CapEx schedule would be deducted here as
  // well as depreciated there.
  const jobViolations: { field: string; message: string }[] = []
  await Promise.all(
    splits.map(async (split, index) => {
      if (!split.workOrderId) return
      const job = await prisma.workOrder.findFirst({
        where: { id: split.workOrderId, propertyId: split.propertyId },
        select: { id: true, capitalImprovement: { select: { id: true } } },
      })
      if (!job) {
        jobViolations.push({
          field: `splits.${index}.workOrderId`,
          message: 'No work order on that property has this ID.',
        })
        return
      }
      if (job.capitalImprovement) {
        jobViolations.push({
          field: `splits.${index}.workOrderId`,
          message: 'That job was capitalised — its cost is already on the CapEx schedule.',
        })
      }
    }),
  )
  if (jobViolations.length > 0) return violationsToState(jobViolations)

  try {
    await prisma.vendorInvoice.create({
      data: {
        legalEntityId: input.legalEntityId,
        vendorId: input.vendorId,
        invoiceNumber: input.invoiceNumber,
        totalCents: input.totalCents as number,
        // `@db.Date` - a calendar day, converted the one way a date-only
        // value may be (D-3).
        invoicedOn: businessDateToUtc(input.invoicedOn),
        // A real timestamp: when the money left. `businessDateToUtc` is
        // right here too - the form collects a day, and midnight UTC on that
        // day is what the export then reads back through the property's own
        // zone.
        paidAt: input.paidOn ? businessDateToUtc(input.paidOn) : null,
        paymentMethod: input.paymentMethod,
        notes: input.notes,
        recordedByStaffId: actor.id,
        splits: {
          create: splits.map((split) => ({
            propertyId: split.propertyId,
            category: split.category,
            amountCents: split.amountCents as number,
            workOrderId: split.workOrderId,
            description: split.description,
          })),
        },
      },
      select: { id: true },
    })
  } catch (error) {
    // The unique index on `workOrderId` is the only way two people racing can
    // produce a double deduction, and it is the database that catches it.
    if (error instanceof Error && error.message.includes('VendorInvoiceSplit_workOrderId_key')) {
      return {
        error: 'One of those work orders is already on another invoice. Reload and check.',
      }
    }
    throw error
  }

  // No audit entry, matching `addCapitalImprovement` and the rest of the
  // filing cabinet: this is bookkeeping a PM enters and corrects, not a
  // privileged or disputed act like an access-code reveal. `recordedByStaffId`
  // on the row is who entered it, which is the question that actually gets
  // asked here.
  revalidatePath('/money/vendor-invoices')
  redirect('/money/vendor-invoices')
}
