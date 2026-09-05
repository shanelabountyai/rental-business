'use server'

import { createHash, randomUUID } from 'node:crypto'
import { formatCents } from '@rental/core/money'
import { depositSlipBlocks } from '@rental/core/payments'
import { businessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Grouping undeposited offline payments into one printable deposit slip
// (PAY-05's own named leftover, R-166).
//
// ONE BATCH IS ONE FORM SUBMIT NAMING ONE GROUP - the ids `listUndepositedDepositGroups`
// already grouped by date, receiver and legal entity, submitted as a hidden
// field per row. Re-checked here rather than trusted from the form for the
// same reason every write in this product re-derives its facts: a tampered
// submission naming payments from two different receivers or two different
// entities would print a slip that misdescribes what physically happened,
// and the whole point of this document is that the bank line reconciles to
// it.

export interface DepositFormState {
  error?: string
  notice?: string
  documentId?: string
}

export async function createDepositBatch(
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const paymentIds = formData.getAll('paymentId').filter((v): v is string => typeof v === 'string')
  if (paymentIds.length === 0) {
    return { error: 'Select at least one payment to deposit.' }
  }

  const { actor } = await requireScope('ledger.adjust')
  const scope = await currentScope(actor)

  const payments = await prisma.payment.findMany({
    where: { id: { in: paymentIds } },
    select: {
      id: true,
      propertyId: true,
      amountCents: true,
      channel: true,
      checkNumber: true,
      receivedAt: true,
      depositBatchId: true,
      status: true,
      property: {
        select: {
          id: true,
          name: true,
          timezone: true,
          legalEntityId: true,
          legalEntity: { select: { name: true } },
        },
      },
      lease: { select: { unit: { select: { name: true } } } },
      leasePayer: {
        select: {
          tenant: { select: { firstName: true, lastName: true } },
          externalPayerName: true,
        },
      },
    },
  })
  if (payments.length !== paymentIds.length) {
    return { error: 'One of those payments no longer exists.' }
  }
  if (!payments.every((p) => scope.propertyIds.includes(p.propertyId))) {
    return { error: 'One of those payments is outside what you can see.' }
  }
  if (payments.some((p) => p.depositBatchId !== null)) {
    return { error: 'One of those payments has already been deposited.' }
  }
  if (payments.some((p) => p.status !== 'SETTLED')) {
    return { error: 'One of those payments is not settled.' }
  }

  // Same three facts `groupForDeposit` groups by. A submission spanning more
  // than one is refused rather than silently split - printing a slip for a
  // group the form did not actually ask for is worse than refusing outright.
  const entityIds = new Set(payments.map((p) => p.property.legalEntityId))
  const receivedOns = new Set(
    payments.map((p) => businessDate(p.receivedAt, p.property.timezone)),
  )
  if (entityIds.size > 1) {
    return { error: 'These payments are not all under the same legal entity.' }
  }
  if (receivedOns.size > 1) {
    return { error: 'These payments were not all received on the same day.' }
  }

  const receivedOn = [...receivedOns][0]!
  const entity = payments[0]!.property.legalEntity
  const totalCents = payments.reduce((sum, p) => sum + p.amountCents, 0)
  const zone = payments[0]!.property.timezone
  const staff = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { name: true },
  })

  const bytes = await renderBlocksPdf(
    depositSlipBlocks({
      entityName: entity.name,
      receivedByName: staff?.name ?? 'Not recorded',
      receivedOn: friendlyDate(payments[0]!.receivedAt, zone),
      generatedAt: friendlyTimestamp(new Date(), zone),
      lines: payments.map((p) => ({
        description: `${
          p.leasePayer.tenant
            ? `${p.leasePayer.tenant.firstName} ${p.leasePayer.tenant.lastName}`
            : (p.leasePayer.externalPayerName ?? 'Payer')
        } — ${p.property.name} ${p.lease.unit.name}`,
        channel: p.channel,
        checkNumber: p.checkNumber,
        amountCents: p.amountCents,
      })),
      totalCents,
    }),
    { title: `Deposit slip — ${entity.name} — ${receivedOn}` },
  )
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `deposit-slip-${receivedOn}-${randomUUID().slice(0, 8)}.pdf`
  const storageKey = generateStorageKey(payments[0]!.propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const batchId = randomUUID()
  const now = new Date()

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        // Anchored to the entity, not one property - a batch can span every
        // property under it (one bank account), and no single propertyId
        // would be honest about that.
        legalEntityId: payments[0]!.property.legalEntityId,
        type: 'DEPOSIT_SLIP',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    await tx.payment.updateMany({
      where: { id: { in: paymentIds } },
      data: { depositBatchId: batchId, depositedAt: now, depositSlipDocumentId: document.id },
    })
    await audit(
      {
        action: 'payment.deposit_batch_created',
        entityType: 'Document',
        entityId: document.id,
        after: {
          batchId,
          documentId: document.id,
          paymentIds,
          totalCents,
          receivedOn,
          legalEntityId: payments[0]!.property.legalEntityId,
        },
      },
      tx,
    )
    return document.id
  })

  // NOT revalidated here, deliberately (R-044's trap, again). Refreshing the
  // list in the same transition that creates the confirmation would remove
  // THIS card - the one carrying the "print the slip" link and the
  // useEffect that bubbles it up to the always-mounted banner - before
  // either had a chance to run. The list catches up on the next navigation,
  // which for this screen is the ordinary way to reach it a second time;
  // see DepositGroupCard's own header for the fuller version of this.
  return { notice: `Deposit slip created for ${formatCents(totalCents)}.`, documentId }
}
