'use server'

import { createHash } from 'node:crypto'
import {
  acceptanceWarning,
  costTotals,
  cureVerdictSentence,
  packetBlocks,
  type PacketExhibit,
} from '@rental/core/evictions'
import { statementBlocks, statementForPeriod } from '@rental/core/ledger'
import { noticeTypeLabel } from '@rental/core/notices'
import { businessDate, friendlyBusinessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { assemblePacket } from '@/lib/pdf/packet.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { cureClockFor, getEvictionCase } from '@/lib/evictions/queries.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import type { EvictionFormState } from '@/lib/evictions/actions.ts'

// The one-click attorney packet (PAY-14, R-083).
//
// ASSEMBLY, NOT NEW MACHINERY. The renderer, the block vocabulary, the
// whole-PDF append and the statement arithmetic all already exist (R-051,
// R-052). What did not exist is one bundle: the case summary, the statement
// of account, every notice with its proof of service, the executed lease and
// the photographs, in one file an attorney can be handed.
//
// D-50's RULE GOVERNS THIS FILE. Never silently drop an attachment; name
// every exhibit that could not be included, on the index, in the document,
// and on the audit row - and make those three agree. A packet quietly missing
// the one photograph that would not parse is worse than one that never
// claimed to have photographs.

/// Document types worth putting in front of an attorney. Deliberately a
/// narrow list rather than "every document on the lease": a packet padded
/// with W-9s and inspection templates is one nobody reads to the end.
const EXHIBIT_TYPES: Record<string, string> = {
  LEASE: 'Lease',
  NOTICE: 'Notice',
  NOTICE_PROOF: 'Proof of service',
  NOTICE_TO_VACATE: 'Notice to vacate',
  LEDGER_STATEMENT: 'Statement of account',
  COMMS_TRANSCRIPT: 'Communications transcript',
  INSPECTION_PHOTO: 'Inspection photograph',
  MAINTENANCE_PHOTO: 'Maintenance photograph',
  COMPLETION_PHOTO: 'Completion photograph',
  UNIT_PHOTO: 'Unit photograph',
}

interface Candidate {
  documentId: string
  label: string
  kind: string
  occurredAt: Date | null
}

/**
 * Produces and archives the attorney packet for a case.
 *
 * NOT IDEMPOTENT, the same call R-052 made for the statement and transcript:
 * a packet is a claim about the record on a date, and the record keeps
 * moving. Each export is separately archived so "the packet we sent counsel
 * in March" survives March.
 */
export async function exportAttorneyPacket(
  caseId: string,
  _previous: EvictionFormState,
  _formData: FormData,
): Promise<EvictionFormState> {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor: guarded } = await requireScope('eviction.manage')
  const scope = await currentScope(guarded)
  const evictionCase = await getEvictionCase(caseId, scope)
  if (!evictionCase) return { error: 'That case no longer exists.' }

  const actor = await requirePermission('eviction.manage', propertyResource(evictionCase.property))
  const zone = evictionCase.property.timezone
  const generatedAt = new Date()

  const { clock, paymentsSinceService, acceptanceWaivesNotice, demand } = await cureClockFor(evictionCase)

  // The ledger, read whole. `statementForPeriod` needs the entire history to
  // carry a balance - see its own comment on why filtering first produces a
  // document that is internally consistent and materially false.
  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId: evictionCase.leaseId },
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
  const period = statementForPeriod(rows, null, null)

  const staff = await prisma.staffUser.findUnique({ where: { id: actor.id }, select: { name: true } })
  const generatedBy = staff?.name ?? 'Not recorded'
  const tenantNames = evictionCase.lease.leaseTenants.map(
    (lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`,
  )

  // The statement of account is RENDERED FRESH rather than assumed to have
  // been produced already. PAY-14 says one click, and a packet that told the
  // PM to go generate a statement first and come back would not be that.
  // Stripe's own invoice PDFs are deliberately NOT embedded here - that is
  // `exportLedgerStatement`'s job (D-50) and doing it twice would double a
  // slow, failure-prone provider round trip inside an already-large bundle.
  const statementPdf = await renderBlocksPdf(
    statementBlocks({
      propertyName: evictionCase.property.name,
      addressLine1: evictionCase.property.addressLine1,
      unitName: evictionCase.unit.name,
      tenantNames,
      periodFrom: null,
      periodTo: null,
      timezone: zone,
      generatedAt: friendlyTimestamp(generatedAt, zone),
      generatedBy,
      formatDate: (instant) => friendlyDate(instant, zone),
      openingBalanceCents: period.openingBalanceCents,
      closingBalanceCents: period.closingBalanceCents,
      lines: period.lines,
      attachedInvoiceIds: [],
      unattachedInvoiceIds: [],
    }),
    { title: `Statement of account — ${evictionCase.property.name}` },
  )

  // Every notice filed under this case, each followed by the proof of each
  // service - in service order, so the bundle reads the way the events
  // happened rather than the way the database returned them.
  const candidates: Candidate[] = []
  for (const notice of evictionCase.notices) {
    if (notice.documentId) {
      candidates.push({
        documentId: notice.documentId,
        label: noticeTypeLabel(notice.type),
        kind: 'Notice',
        occurredAt: notice.servedAt ?? notice.generatedAt,
      })
    }
    for (const delivery of notice.deliveries) {
      if (delivery.proofDocumentId) {
        candidates.push({
          documentId: delivery.proofDocumentId,
          label: `${noticeTypeLabel(notice.type)} — served ${delivery.method.toLowerCase().replace(/_/g, ' ')}`,
          kind: 'Proof of service',
          occurredAt: delivery.servedAt,
        })
      }
    }
  }

  // The executed lease, and then everything else worth showing.
  const envelope = await prisma.leaseEnvelope.findFirst({
    // R-090: `kind` matters. An executed AMENDMENT also has an
    // `executedDocumentId`, and the most recent one would have been handed to
    // counsel labelled "Executed lease and addenda".
    where: { leaseId: evictionCase.leaseId, kind: 'LEASE', executedDocumentId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { executedDocumentId: true },
  })
  if (envelope?.executedDocumentId) {
    candidates.push({
      documentId: envelope.executedDocumentId,
      label: 'Executed lease and addenda',
      kind: 'Lease',
      occurredAt: null,
    })
  }

  const alreadyCited = new Set(candidates.map((c) => c.documentId))
  const others = await prisma.document.findMany({
    where: {
      deletedAt: null,
      id: { notIn: [...alreadyCited] },
      type: { in: Object.keys(EXHIBIT_TYPES) },
      OR: [{ leaseId: evictionCase.leaseId }, { unitId: evictionCase.unitId }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, fileName: true, capturedAt: true, createdAt: true },
  })
  for (const document of others) {
    candidates.push({
      documentId: document.id,
      label: document.fileName,
      kind: EXHIBIT_TYPES[document.type] ?? document.type,
      occurredAt: document.capturedAt ?? document.createdAt,
    })
  }

  return finish({
    evictionCase,
    zone,
    generatedAt,
    generatedBy,
    tenantNames,
    clock,
    paymentsSinceService,
    acceptanceWaivesNotice,
    cureVerdict: demand ? cureVerdictSentence(demand.verdict, clock.state) : null,
    closingBalanceCents: period.closingBalanceCents,
    statementPdf,
    candidates,
    actorId: actor.id,
  })
}

async function finish(args: {
  evictionCase: NonNullable<Awaited<ReturnType<typeof getEvictionCase>>>
  zone: string
  generatedAt: Date
  generatedBy: string
  tenantNames: string[]
  clock: Awaited<ReturnType<typeof cureClockFor>>['clock']
  paymentsSinceService: Awaited<ReturnType<typeof cureClockFor>>['paymentsSinceService']
  acceptanceWaivesNotice: boolean | null
  cureVerdict: string | null
  closingBalanceCents: number
  statementPdf: Uint8Array
  candidates: Candidate[]
  actorId: string
}): Promise<EvictionFormState> {
  const { evictionCase, zone, generatedAt, generatedBy, tenantNames, clock, statementPdf, candidates } = args

  const totals = costTotals(evictionCase.costs)
  const asDate = (value: Date | null) => (value ? friendlyDate(value, zone) : null)

  // One builder, parameterized by which exhibits actually made it in - the
  // same shape `exportLedgerStatement` uses, and for the same reason: two
  // copies of the fact-building drift, and the second render silently prints
  // a stale index.
  const buildExhibits = (isAttached: (documentId: string) => boolean): PacketExhibit[] => [
    {
      label: 'Statement of account',
      kind: 'Ledger',
      occurredOn: friendlyDate(generatedAt, zone),
      attached: isAttached('statement'),
    },
    ...candidates.map((candidate) => ({
      label: candidate.label,
      kind: candidate.kind,
      occurredOn: candidate.occurredAt ? friendlyDate(candidate.occurredAt, zone) : null,
      attached: isAttached(candidate.documentId),
    })),
  ]

  const {
    bytes: buffer,
    attachedCount,
    notAttached,
  } = await assemblePacket({
    candidates,
    leading: [{ label: 'statement', bytes: new Uint8Array(statementPdf) }],
    render: (isAttached) =>
      renderBlocksPdf(
        packetBlocks({
          propertyName: evictionCase.property.name,
          addressLine1: evictionCase.property.addressLine1,
          unitName: evictionCase.unit.name,
          tenantNames,
          stage: evictionCase.stage,
          outcome: evictionCase.outcome,
          openedOn: friendlyDate(evictionCase.openedAt, zone),
          closedOn: asDate(evictionCase.closedAt),
          filedOn: asDate(evictionCase.filedOn),
          courtDate: evictionCase.courtDate ? friendlyTimestamp(evictionCase.courtDate, zone) : null,
          judgmentOn: asDate(evictionCase.judgmentOn),
          writOn: asDate(evictionCase.writOn),
          lockoutOn: asDate(evictionCase.lockoutOn),
          clock,
          // R-156: named on the cover sheet, never omitted (D-50). Dates are
          // formatted here because the packet quotes them as prose.
          paymentsSinceService: args.paymentsSinceService.map((payment) => ({
            receivedOn: friendlyBusinessDate(payment.receivedOn),
            amountCents: payment.amountCents,
            channelLabel: payment.channelLabel,
          })),
          acceptanceWarning: acceptanceWarning(args.acceptanceWaivesNotice),
          cureVerdict: args.cureVerdict,
          costs: totals,
          ledgerBalanceCents: args.closingBalanceCents,
          exhibits: buildExhibits(isAttached),
          generatedAt: friendlyTimestamp(generatedAt, zone),
          generatedBy,
          timezone: zone,
        }),
        { title: `Eviction case file — ${evictionCase.property.name}` },
      ),
  })

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `eviction-packet-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(evictionCase.propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId: evictionCase.propertyId,
        leaseId: evictionCase.leaseId,
        // No tenantId, the same call R-052 made for the statement and the
        // transcript: a packet assembled for a case AGAINST this tenant must
        // never appear in their own portal.
        type: 'ATTORNEY_PACKET',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: args.actorId,
      },
    })
    await audit(
      {
        action: 'eviction.packet_exported',
        entityType: 'EvictionCase',
        entityId: evictionCase.id,
        propertyId: evictionCase.propertyId,
        after: {
          documentId: document.id,
          // The TRUE outcome, not the hoped-for one. The audit row and the
          // packet's own index must agree about what is in the file.
          exhibitsAttached: attachedCount,
          exhibitsNotAttached: notAttached,
          sha256,
        },
      },
      tx,
    )
    return document.id
  })

  revalidatePath(`/evictions/${evictionCase.id}`)
  return {
    notice:
      notAttached.length > 0
        ? `Packet produced. ${notAttached.length} ${notAttached.length === 1 ? 'exhibit is' : 'exhibits are'} named on the index but could not be attached.`
        : 'Packet produced.',
    documentId,
  }
}
