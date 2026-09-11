'use server'

import { createHash } from 'node:crypto'
import { formatCents } from '@rental/core/money'
import { settlementReportBlocks, validateSettlementTransfer } from '@rental/core/payments'
import {
  type BusinessDate,
  businessDateToUtc,
  friendlyBusinessDate,
  friendlyTimestamp,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import {
  type RecordedSettlement,
  recordedSettlements,
  settlementReport,
} from '@/lib/reports/settlement.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { reportToday } from '@/lib/scope/report-today.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Recording the inter-entity sweep (review finding 12, R-198).
//
// ASSEMBLY, the call R-081d made for the tax packet. `settlementReport` already
// computes each entity's share and `renderBlocksPdf` already draws; what did
// not exist is the dated record that the money moved, with the report it was
// computed from kept exactly as it stood. `recordDepositRefund` is the shape
// for money going out - write-once, a reference that matches a bank line,
// `ledger.adjust` because nobody on the other side can disagree - and
// `archiveTaxPacket` is the shape for the entity-owned document.
//
// THE OWED FIGURE IS RECOMPUTED HERE, never posted back from the form. A number
// the browser sends is a number anybody can edit, and this one is the claim
// the whole record rests on.

export interface SettlementTransferState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function str(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

function alreadyRecorded(row: RecordedSettlement): string {
  return `A transfer is already recorded for ${friendlyBusinessDate(row.windowFrom)} to ${friendlyBusinessDate(row.windowTo)} (${formatCents(row.transferredCents)} on ${friendlyBusinessDate(row.transferredOn)}). Recording another for overlapping dates would move the same rent twice.`
}

export async function recordSettlementTransfer(
  _previous: SettlementTransferState,
  formData: FormData,
): Promise<SettlementTransferState> {
  const legalEntityId = str(formData, 'entity')
  const from = str(formData, 'from')
  const to = str(formData, 'to')
  if (!legalEntityId || !DAY.test(from) || !DAY.test(to) || from > to) {
    return { error: 'Choose a date range first.' }
  }

  // Entity-scoped, as `archiveTaxPacket`'s check is: a property-scoped grant
  // never covers a `legalEntityId` resource, and sweeping an LLC's whole share
  // is not a one-house act. Privileged, so an owner without a second factor is
  // sent to enrol (ROLE-05).
  const actor = await requirePermission('ledger.adjust', { legalEntityId })
  const scope = await currentScope(actor)

  // THE WHOLE ENTITY, NOT THE CURRENT SELECTION. The switcher can narrow the
  // page to one house, and a share worked out from some of an LLC's houses is
  // not what it is owed. The page offers no form in that state; this is the
  // check that does not depend on the page.
  const propertyIds = scope.availableProperties
    .filter((property) => property.legalEntityId === legalEntityId)
    .map((property) => property.id)
  // Out of scope answers the same as absent (ROLE-01).
  if (propertyIds.length === 0) return { error: 'That entity is not available.' }
  const entityScope = { ...scope, propertyIds }

  const now = new Date()
  const today = reportToday(entityScope, now)
  const report = await settlementReport(entityScope, from as BusinessDate, to as BusinessDate)
  const share = report.entities.find((entity) => entity.legalEntityId === legalEntityId)

  const { violations, transferredCents } = validateSettlementTransfer(
    {
      from: from as BusinessDate,
      to: to as BusinessDate,
      grossCents: share?.netCents ?? 0,
      amountDollars: str(formData, 'amountDollars'),
      transferredOn: str(formData, 'transferredOn'),
      reference: str(formData, 'reference'),
    },
    today,
  )
  const refusal = violations.find((violation) => violation.field === 'window')
  if (refusal) return { error: refusal.message }
  if (!share || transferredCents === null) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }
  const transferredOn = str(formData, 'transferredOn') as BusinessDate
  const reference = str(formData, 'reference')

  // Checked before the PDF is drawn so an ordinary refusal costs nothing, and
  // again under the lock below, which is the check that counts.
  const [existing] = await recordedSettlements([legalEntityId], from as BusinessDate, to as BusinessDate)
  if (existing) return { error: alreadyRecorded(existing) }

  const staff = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { name: true },
  })
  // One zone for the artifact's own timestamp, the tax packet's call: an
  // entity's houses can sit in several zones (D-3), and every figure inside is
  // already dated through its own property's clock upstream.
  const zone = 'UTC'

  const bytes = await renderBlocksPdf(
    settlementReportBlocks({
      entityName: share.entityName,
      from: from as BusinessDate,
      to: to as BusinessDate,
      settledCents: share.settledCents,
      reversedCents: share.reversedCents,
      grossCents: share.netCents,
      transferredCents,
      transferredOn,
      reference,
      properties: share.properties.map((property) => ({
        name: property.propertyName,
        settledCents: property.settledCents,
        reversedCents: property.reversedCents,
        netCents: property.netCents,
      })),
      payments: report.rows
        .filter((row) => row.legalEntityId === legalEntityId)
        .map((row) => ({
          settledOn: row.settledOn,
          property: row.unitName ? `${row.propertyName} ${row.unitName}` : row.propertyName,
          payer: row.payerName,
          amountCents: row.amountCents,
          reversedOn: row.reversedOn,
        })),
      recordedBy: staff?.name ?? 'Not recorded',
      generatedAt: friendlyTimestamp(now, zone),
    }),
    {
      title: `Settlement report — ${share.entityName} — ${friendlyBusinessDate(from as BusinessDate)} to ${friendlyBusinessDate(to as BusinessDate)}`,
    },
  )
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `settlement-${from}-to-${to}.pdf`
  // Through the generator, so no two archives can share an object.
  const storageKey = generateStorageKey(legalEntityId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const raced = await prisma.$transaction(async (tx) => {
    // Two presses, or two tabs, would each pass the check above. One lock per
    // entity serialises them, and the second sees the first's row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entity-settlement:${legalEntityId}`}))`
    const [overlap] = await recordedSettlements([legalEntityId], from as BusinessDate, to as BusinessDate, tx)
    if (overlap) return overlap

    const document = await tx.document.create({
      data: {
        // The ENTITY, not a property: the shared account's money belongs to no
        // one house, and no tenant is a party to it.
        legalEntityId,
        type: 'SETTLEMENT_REPORT',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    const settlement = await tx.entitySettlement.create({
      data: {
        legalEntityId,
        windowFrom: businessDateToUtc(from),
        windowTo: businessDateToUtc(to),
        grossCents: share.netCents,
        transferredCents,
        transferredOn: businessDateToUtc(transferredOn),
        reference,
        documentId: document.id,
        recordedById: actor.id,
      },
    })
    await audit(
      {
        action: 'settlement.transfer_recorded',
        entityType: 'EntitySettlement',
        entityId: settlement.id,
        after: {
          legalEntityId,
          from,
          to,
          grossCents: share.netCents,
          settledCents: share.settledCents,
          reversedCents: share.reversedCents,
          transferredCents,
          transferredOn,
          reference,
          documentId: document.id,
          paymentCount: share.paymentIds.length,
          sha256,
        },
      },
      tx,
    )
    return null
  })
  // The archived object is left behind on this path, the same as any archive
  // whose write fails after the upload; nothing references it.
  if (raced) return { error: alreadyRecorded(raced) }

  // Back to the same range, where the record now stands in place of the form.
  // A notice in the form's own state would unmount with it.
  revalidatePath('/reports/settlement')
  redirect(`/reports/settlement?from=${from}&to=${to}`)
}
