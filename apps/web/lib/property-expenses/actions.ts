'use server'

import { createHash } from 'node:crypto'
import { validateDocument } from '@rental/core/documents'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import {
  type PropertyExpenseInput,
  WHOLE_ENTITY_OPTION,
  validatePropertyExpense,
} from '@rental/core/tax'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireScope } from '@/lib/auth/guard.ts'
import { type ResolvedScope, currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for owner-side outlay nobody invoiced (R-193).
//
// No audit entry, matching `recordVendorInvoice`: this is bookkeeping a PM
// enters, and `recordedByStaffId` on the row answers who entered it.

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

/// Dollars in, integer cents out. Null for a blank, so validation can tell
/// "not filled in" from "zero".
function cents(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  if (!raw) return null
  const dollars = Number(raw)
  return Number.isNaN(dollars) ? Number.NaN : Math.round(dollars * 100)
}

/// The clock a row is read on, or null when the actor cannot see it: the
/// property's own zone, or for an entity-wide row the zone of one of that
/// entity's houses - the same choice `buildTaxExport` makes.
function clockFor(
  scope: ResolvedScope,
  legalEntityId: string,
  propertyId: string | null,
): string | null {
  const houses = scope.availableProperties.filter((p) => p.legalEntityId === legalEntityId)
  if (propertyId == null) return houses[0]?.timezone ?? null
  return houses.find((p) => p.id === propertyId)?.timezone ?? null
}

export async function recordPropertyExpense(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { actor } = await requireScope('property.write')
  const scope = await currentScope(actor)

  const propertyChoice = str(formData, 'propertyId')
  const input: PropertyExpenseInput = {
    legalEntityId: str(formData, 'legalEntityId'),
    propertyId: propertyChoice === WHOLE_ENTITY_OPTION ? null : propertyChoice,
    category: str(formData, 'category'),
    amountCents: cents(formData, 'amountDollars'),
    paidOn: str(formData, 'paidOn'),
    description: str(formData, 'description'),
  }
  const recursMonthly = formData.get('recursMonthly') === 'on'

  const zone = clockFor(scope, input.legalEntityId, input.propertyId || null)
  const violations = validatePropertyExpense(input, businessDate(new Date(), zone ?? 'UTC'))
  if (violations.length > 0) return violationsToState(violations)

  // Scope and the entity boundary. A property on another entity's books is
  // money that would leave one return without arriving on any other.
  if (zone == null) {
    const property = scope.availableProperties.find((p) => p.id === input.propertyId)
    return violationsToState([
      input.propertyId == null
        ? { field: 'legalEntityId', message: 'No entity you can see has that ID.' }
        : property
          ? { field: 'propertyId', message: `${property.name} belongs to a different legal entity.` }
          : { field: 'propertyId', message: 'No property you can see has that ID.' },
    ])
  }

  const file = formData.get('document')
  const upload = file instanceof File && file.size > 0 ? file : null
  if (upload) {
    const fileViolations = validateDocument({
      // The check only asks that the document has an owner, and an entity is
      // one (R-081d's `Document.legalEntityId`).
      propertyId: input.propertyId ?? input.legalEntityId,
      type: 'INVOICE',
      fileName: upload.name,
      contentType: upload.type || 'application/octet-stream',
      sizeBytes: upload.size,
    })
    if (fileViolations.length > 0) {
      return violationsToState(fileViolations.map((v) => ({ ...v, field: 'document' })))
    }
  }

  let stored: { storageKey: string; sha256: string; contentType: string } | null = null
  if (upload) {
    const buffer = Buffer.from(await upload.arrayBuffer())
    const contentType = upload.type || 'application/octet-stream'
    const storageKey = generateStorageKey(input.propertyId ?? input.legalEntityId, upload.name)
    // Before the row, as `uploadDocument` does: a failed commit leaves an
    // unread file, never a row pointing at nothing.
    await storage.put(storageKey, buffer, contentType)
    stored = { storageKey, sha256: createHash('sha256').update(buffer).digest('hex'), contentType }
  }

  await prisma.$transaction(async (tx) => {
    const document =
      upload && stored
        ? await tx.document.create({
            data: {
              propertyId: input.propertyId,
              legalEntityId: input.propertyId == null ? input.legalEntityId : null,
              type: 'INVOICE',
              fileName: upload.name,
              contentType: stored.contentType,
              sizeBytes: upload.size,
              storageKey: stored.storageKey,
              sha256: stored.sha256,
              uploadedByStaffId: actor.id,
            },
            select: { id: true },
          })
        : null
    await tx.propertyExpense.create({
      data: {
        legalEntityId: input.legalEntityId,
        propertyId: input.propertyId,
        category: input.category,
        amountCents: input.amountCents as number,
        description: input.description,
        // `@db.Date`: a calendar day, converted the one way a date-only value
        // may be (D-3).
        paidOn: businessDateToUtc(input.paidOn),
        recursMonthly,
        documentId: document?.id ?? null,
        recordedByStaffId: actor.id,
      },
    })
  })

  revalidatePath('/money/expenses')
  redirect('/money/expenses')
}

/**
 * End a monthly series today, on the row's own clock. Today's payment stays
 * booked, because it was made.
 *
 * Bound per row on the page. A second press, a row out of scope or a one-off
 * changes nothing.
 */
export async function stopExpenseRecurrence(expenseId: string): Promise<void> {
  const { actor } = await requireScope('property.write')
  const scope = await currentScope(actor)

  const expense = await prisma.propertyExpense.findUnique({
    where: { id: expenseId },
    select: { legalEntityId: true, propertyId: true, paidOn: true },
  })
  const zone = expense && clockFor(scope, expense.legalEntityId, expense.propertyId)
  if (expense && zone) {
    const today = businessDate(new Date(), zone)
    const paidOn = utcToBusinessDate(expense.paidOn)
    await prisma.propertyExpense.updateMany({
      where: { id: expenseId, recursMonthly: true, recurrenceEndsOn: null },
      data: { recurrenceEndsOn: businessDateToUtc(today > paidOn ? today : paidOn) },
    })
  }

  revalidatePath('/money/expenses')
  redirect('/money/expenses')
}
