'use server'

import { formatCents } from '@rental/core/money'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { formerTenantReceivables } from '@/lib/payments/former-tenants.ts'

export interface WriteOffFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

/**
 * Stops pursuing a former tenant's balance (R-215, D-233).
 *
 * NOT A LEDGER WRITE. The debt stays owed in Stripe and on the ledger; this
 * records the owner's dated, reasoned decision and moves the row off the
 * list somebody works. `ledger.adjust`, because deciding money will not be
 * collected is exactly as privileged as recording that it was.
 *
 * The amount is READ HERE, never taken from the form - the record says what
 * was actually owed on the day, whatever the screen showed when it loaded.
 */
export async function writeOffReceivable(
  leaseId: string,
  _previous: WriteOffFormState,
  formData: FormData,
): Promise<WriteOffFormState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      status: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  const actor = await requirePermission('ledger.adjust', propertyResource(lease.property))

  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { reason: 'Say why it is being written off.' } }
  }
  if (lease.status !== 'ENDED' && lease.status !== 'TERMINATED') {
    return { error: 'Only a former tenancy can be written off. A live one is chased from the rent roll.' }
  }

  const { pursuing } = await formerTenantReceivables({ propertyIds: [lease.propertyId] })
  const row = pursuing.find((candidate) => candidate.leaseId === lease.id)
  if (!row) {
    return { error: 'Nothing is owed on this tenancy, or it has already been written off.' }
  }

  const writtenOffOn = businessDate(new Date(), lease.property.timezone)
  await prisma.$transaction(async (tx) => {
    const created = await tx.receivableWriteOff.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        amountCents: row.owedCents,
        writtenOffOn: businessDateToUtc(writtenOffOn),
        reason,
        staffUserId: actor.id,
      },
    })
    await audit(
      {
        action: 'receivable.written_off',
        entityType: 'ReceivableWriteOff',
        entityId: created.id,
        propertyId: lease.propertyId,
        after: { leaseId: lease.id, amountCents: row.owedCents, writtenOffOn },
        reason,
      },
      tx,
    )
  })

  revalidatePath('/money/former-tenants')
  return { notice: `${formatCents(row.owedCents)} owed by ${row.tenantName} written off.` }
}
