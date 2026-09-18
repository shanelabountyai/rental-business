'use server'

import { createHash } from 'node:crypto'
import { DEPOSIT_REFUND_INSTRUMENTS, type DepositRefundInstrument, depositPacketBlocks } from '@rental/core/ledger'
import { type NoticeServiceMethodName, SERVICE_METHOD_LABELS } from '@rental/core/notices'
import { businessDate, friendlyDate, friendlyTimestamp, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
import type { DepositFormState } from '@/lib/deposits/actions.ts'
import { assemblePacket, type PacketCandidate } from '@/lib/pdf/packet.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { baselineMoveInFor, tenancyLeaseIds } from '@/lib/inspections/move-out-copy.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// The deposit-dispute packet (INSP-03/INSP-05/PAY-11, R-218).
//
// ASSEMBLY, NOT NEW MACHINERY - R-083's attorney packet, pointed at the case
// an owner at this scale actually defends most years. Every row it reads
// already existed; none of them could be handed over as one document.
//
// D-50's RULE GOVERNS THIS FILE exactly as it governs the eviction packet:
// every exhibit that could not be included is named on the index, in the
// document and on the audit row, and the three agree.

/**
 * Produces and archives the deposit-dispute packet for a lease.
 *
 * NOT IDEMPOTENT, for R-052's reason: a packet is a claim about the record on
 * a date. A refund recorded next week makes a different packet.
 */
export async function exportDepositPacket(
  leaseId: string,
  _previous: DepositFormState,
  _formData: FormData,
): Promise<DepositFormState> {
  // R-103: `requireScope` first, never a resource-less `requirePermission`.
  // `ledger.adjust`, the permission the disposition itself is written under.
  const { actor: guarded } = await requireScope('ledger.adjust')
  const scope = await currentScope(guarded)

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      moveOutAt: true,
      property: {
        select: {
          id: true,
          name: true,
          legalEntityId: true,
          addressLine1: true,
          timezone: true,
        },
      },
      unit: { select: { name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
      deposits: {
        take: 1,
        select: {
          id: true,
          heldCents: true,
          receivedAt: true,
          dispositionDueOn: true,
          dispositionSentAt: true,
          forwardingAddress: true,
          appliedCents: true,
          refundedCents: true,
          refundPaidOn: true,
          refundMethod: true,
          refundReference: true,
          refundDocumentId: true,
          notice: {
            select: {
              id: true,
              documentId: true,
              generatedAt: true,
              deliveries: {
                orderBy: { servedAt: 'asc' },
                select: { method: true, servedAt: true, proofDocumentId: true },
              },
            },
          },
          deductions: {
            orderBy: { createdAt: 'asc' },
            select: {
              description: true,
              amountCents: true,
              estimatedAgeYears: true,
              usefulLifeYears: true,
              workOrder: {
                select: {
                  scope: true,
                  documents: {
                    where: {
                      deletedAt: null,
                      type: { in: ['INVOICE', 'COMPLETION_PHOTO'] },
                    },
                    orderBy: { createdAt: 'asc' },
                    select: {
                      id: true,
                      type: true,
                      fileName: true,
                      capturedAt: true,
                      createdAt: true,
                    },
                  },
                },
              },
              inspectionItem: {
                select: {
                  room: true,
                  item: true,
                  condition: true,
                  moveInItem: { select: { condition: true } },
                },
              },
              evidence: {
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
                select: { id: true, fileName: true, createdAt: true },
              },
            },
          },
        },
      },
    },
  })
  if (!lease || !scope.propertyIds.includes(lease.propertyId)) return { error: 'That lease no longer exists.' }
  const deposit = lease.deposits[0]
  if (!deposit) return { error: 'This lease holds no deposit.' }

  const actor = await requirePermission('ledger.adjust', propertyResource(lease.property))
  const zone = lease.property.timezone
  const generatedAt = new Date()
  const day = (instant: Date | null) => (instant ? businessDate(instant, zone) : null)

  // R-226. The move-in side is the TENANCY's, not this lease's: a renewal
  // carries no move-in report of its own and an inherited tenancy's R-116
  // baseline sits on the lease it was imported as. The move-out is this
  // lease's own - it is the end of the tenancy, which is always the newest row.
  const [chain, baseline] = await Promise.all([tenancyLeaseIds(prisma, leaseId), baselineMoveInFor(prisma, leaseId)])
  const inspection = (where: { leaseId: string; type: 'MOVE_OUT' } | { id: string }) =>
    prisma.inspection.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        performedAt: true,
        tenantSignedAt: true,
        items: {
          orderBy: { order: 'asc' },
          select: {
            room: true,
            item: true,
            condition: true,
            moveInItem: { select: { condition: true } },
            photos: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                fileName: true,
                capturedAt: true,
                createdAt: true,
              },
            },
          },
        },
      },
    })
  const [moveIn, moveOut, envelope, baselines, staff] = await Promise.all([
    baseline ? inspection({ id: baseline.id }) : null,
    inspection({ leaseId, type: 'MOVE_OUT' }),
    // R-090: `kind: 'LEASE'`, or an executed amendment is labelled the lease.
    prisma.leaseEnvelope.findFirst({
      where: { leaseId, kind: 'LEASE', executedDocumentId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { executedDocumentId: true },
    }),
    // R-116: an inherited tenancy's only baseline.
    prisma.document.findMany({
      where: { leaseId: { in: chain }, type: 'CONDITION_BASELINE', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, fileName: true, capturedAt: true, createdAt: true },
    }),
    prisma.staffUser.findUnique({
      where: { id: actor.id },
      select: { name: true },
    }),
  ])

  // In the order a reader argues the case: the letter and its service, the
  // refund, the lease, the condition at each end, then each deduction's own
  // evidence.
  const candidates: PacketCandidate[] = []
  const notice = deposit.notice
  if (notice) {
    candidates.push({
      // A letter whose PDF was never generated has no document, and is still
      // named rather than skipped (D-50). The id matches no stored file, so
      // the index marks it not attached - and its text is on record, which is
      // exactly what the index's own sentence says.
      documentId: notice.documentId ?? `notice-without-pdf:${notice.id}`,
      label: 'Security deposit disposition letter',
      kind: 'Notice',
      occurredAt: notice.generatedAt,
    })
    for (const delivery of notice.deliveries) {
      if (delivery.proofDocumentId) {
        candidates.push({
          documentId: delivery.proofDocumentId,
          label: `Disposition letter — ${methodLabel(delivery.method)}`,
          kind: 'Proof of service',
          occurredAt: delivery.servedAt,
        })
      }
    }
  }
  if (deposit.refundDocumentId) {
    candidates.push({
      documentId: deposit.refundDocumentId,
      label: 'Refund payment',
      kind: 'Receipt',
      occurredAt: deposit.refundPaidOn,
    })
  }
  if (envelope?.executedDocumentId) {
    candidates.push({
      documentId: envelope.executedDocumentId,
      label: 'Executed lease and addenda',
      kind: 'Lease',
      occurredAt: null,
    })
  }
  for (const doc of baselines) {
    candidates.push({
      documentId: doc.id,
      label: doc.fileName,
      kind: 'Condition as found',
      occurredAt: doc.capturedAt ?? doc.createdAt,
    })
  }
  for (const [kind, walk] of [
    ['Move-in photograph', moveIn],
    ['Move-out photograph', moveOut],
  ] as const) {
    for (const item of walk?.items ?? []) {
      for (const photo of item.photos) {
        candidates.push({
          documentId: photo.id,
          label: `${item.room} — ${item.item} (${photo.fileName})`,
          kind,
          occurredAt: photo.capturedAt ?? photo.createdAt,
        })
      }
    }
  }
  for (const deduction of deposit.deductions) {
    for (const doc of deduction.evidence) {
      candidates.push({
        documentId: doc.id,
        label: `${deduction.description} (${doc.fileName})`,
        kind: 'Deduction evidence',
        occurredAt: doc.createdAt,
      })
    }
    for (const doc of deduction.workOrder?.documents ?? []) {
      candidates.push({
        documentId: doc.id,
        label: `${deduction.description} (${doc.fileName})`,
        kind: doc.type === 'INVOICE' ? 'Repair invoice' : 'Completion photograph',
        occurredAt: doc.capturedAt ?? doc.createdAt,
      })
    }
  }
  // One work order can back two deductions; one file is one exhibit.
  const seen = new Set<string>()
  const unique = candidates.filter((c) => !seen.has(c.documentId) && seen.add(c.documentId))

  const generatedBy = staff?.name ?? 'Not recorded'
  const {
    bytes: buffer,
    attachedCount,
    notAttached,
  } = await assemblePacket({
    candidates: unique,
    render: (isAttached) =>
      renderBlocksPdf(
        depositPacketBlocks({
          propertyName: lease.property.name,
          addressLine1: lease.property.addressLine1,
          unitName: lease.unit.name,
          tenantNames: lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`),
          moveOutOn: day(lease.moveOutAt),
          heldCents: deposit.heldCents,
          receivedOn: day(deposit.receivedAt),
          dispositionDueOn: deposit.dispositionDueOn ? utcToBusinessDate(deposit.dispositionDueOn) : null,
          dispositionSentOn: day(deposit.dispositionSentAt),
          forwardingAddress: deposit.forwardingAddress,
          service: (notice?.deliveries ?? []).map((delivery) => ({
            methodLabel: methodLabel(delivery.method),
            servedOn: businessDate(delivery.servedAt, zone),
          })),
          appliedCents: deposit.appliedCents,
          refundedCents: deposit.refundedCents,
          refundPaidOn: deposit.refundPaidOn ? utcToBusinessDate(deposit.refundPaidOn) : null,
          refundMethodLabel: deposit.refundMethod
            ? (DEPOSIT_REFUND_INSTRUMENTS[deposit.refundMethod as DepositRefundInstrument] ?? deposit.refundMethod)
            : null,
          refundReference: deposit.refundReference,
          moveIn: moveIn
            ? {
                performedOn: day(moveIn.performedAt),
                tenantSignedOn: day(moveIn.tenantSignedAt),
              }
            : null,
          moveOut: moveOut ? { performedOn: day(moveOut.performedAt) } : null,
          comparison: (moveOut?.items ?? []).map((item) => ({
            room: item.room,
            item: item.item,
            moveInCondition: item.moveInItem?.condition ?? null,
            moveOutCondition: item.condition,
          })),
          deductions: deposit.deductions.map((deduction) => ({
            description: deduction.description,
            amountCents: deduction.amountCents,
            workOrderScope: deduction.workOrder?.scope ?? null,
            inspectionItem: deduction.inspectionItem
              ? {
                  room: deduction.inspectionItem.room,
                  item: deduction.inspectionItem.item,
                  moveInCondition: deduction.inspectionItem.moveInItem?.condition ?? null,
                  moveOutCondition: deduction.inspectionItem.condition,
                }
              : null,
            evidenceFileCount: deduction.evidence.length,
            estimatedAgeYears: deduction.estimatedAgeYears,
            usefulLifeYears: deduction.usefulLifeYears,
          })),
          exhibits: unique.map((candidate) => ({
            label: candidate.label,
            kind: candidate.kind,
            occurredOn: candidate.occurredAt ? friendlyDate(candidate.occurredAt, zone) : null,
            attached: isAttached(candidate.documentId),
          })),
          generatedAt: friendlyTimestamp(generatedAt, zone),
          generatedBy,
          timezone: zone,
        }),
        { title: `Security deposit dispute file — ${lease.property.name}` },
      ),
  })

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `deposit-packet-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(lease.propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        // No tenantId, R-083's call: a packet assembled against a former
        // tenant's claim must never appear in their own portal.
        type: 'DEPOSIT_PACKET',
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
        action: 'deposit.packet_exported',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: lease.propertyId,
        after: {
          documentId: document.id,
          exhibitsAttached: attachedCount,
          exhibitsNotAttached: notAttached,
          sha256,
        },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${lease.id}`)
  return {
    notice:
      notAttached.length > 0
        ? `Deposit packet produced. ${notAttached.length} ${notAttached.length === 1 ? 'exhibit is' : 'exhibits are'} named on the index but could not be attached.`
        : 'Deposit packet produced.',
  }
}

function methodLabel(method: string): string {
  return SERVICE_METHOD_LABELS[method as NoticeServiceMethodName] ?? method
}
