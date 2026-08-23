'use server'

import { createHash } from 'node:crypto'
import { costTotals, packetBlocks, type PacketExhibit } from '@rental/core/evictions'
import { statementBlocks, statementForPeriod } from '@rental/core/ledger'
import { noticeTypeLabel } from '@rental/core/notices'
import { businessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { appendPdfs, renderBlocksPdf } from '@/lib/pdf/render.ts'
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
  const scope = await currentScope(await requirePermission('eviction.manage'))
  const evictionCase = await getEvictionCase(caseId, scope)
  if (!evictionCase) return { error: 'That case no longer exists.' }

  const actor = await requirePermission('eviction.manage', propertyResource(evictionCase.property))
  const zone = evictionCase.property.timezone
  const generatedAt = new Date()

  const { clock } = await cureClockFor(evictionCase)

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

  // Storage is keyed by `Document.storageKey`, not by document id - resolved
  // in one query rather than one per exhibit, since a packet routinely cites
  // dozens of photographs.
  const keyById = new Map(
    (
      await prisma.document.findMany({
        where: { id: { in: candidates.map((c) => c.documentId) } },
        select: { id: true, storageKey: true },
      })
    ).map((d) => [d.id, d.storageKey]),
  )

  // Fetch every candidate's bytes. A storage miss is a named gap, never a
  // failed export - one unreadable photograph must not cost the owner the
  // whole packet.
  const fetched = await Promise.all(
    candidates.map(async (candidate) => {
      const key = keyById.get(candidate.documentId)
      if (!key) return { candidate, bytes: null }
      try {
        return { candidate, bytes: await storage.get(key) }
      } catch {
        return { candidate, bytes: null }
      }
    }),
  )

  return finish({
    evictionCase,
    zone,
    generatedAt,
    generatedBy,
    tenantNames,
    clock,
    closingBalanceCents: period.closingBalanceCents,
    statementPdf,
    fetched,
    actorId: actor.id,
  })
}

type Fetched = { candidate: Candidate; bytes: Buffer | null }

async function finish(args: {
  evictionCase: NonNullable<Awaited<ReturnType<typeof getEvictionCase>>>
  zone: string
  generatedAt: Date
  generatedBy: string
  tenantNames: string[]
  clock: Awaited<ReturnType<typeof cureClockFor>>['clock']
  closingBalanceCents: number
  statementPdf: Uint8Array
  fetched: Fetched[]
  actorId: string
}): Promise<EvictionFormState> {
  const { evictionCase, zone, generatedAt, generatedBy, tenantNames, clock, statementPdf, fetched } = args

  const available = fetched.filter((row): row is { candidate: Candidate; bytes: Buffer } => row.bytes !== null)
  const unreadable = new Set(fetched.filter((row) => row.bytes === null).map((row) => row.candidate.documentId))

  const totals = costTotals(evictionCase.costs)
  const asDate = (value: Date | null) => (value ? friendlyDate(value, zone) : null)

  // One builder, parameterized by which exhibits actually made it in - the
  // same shape `exportLedgerStatement` uses, and for the same reason: two
  // copies of the fact-building drift, and the second render silently prints
  // a stale index.
  const buildExhibits = (failed: ReadonlySet<string>): PacketExhibit[] => [
    { label: 'Statement of account', kind: 'Ledger', occurredOn: friendlyDate(generatedAt, zone), attached: true },
    ...fetched.map(({ candidate }) => ({
      label: candidate.label,
      kind: candidate.kind,
      occurredOn: candidate.occurredAt ? friendlyDate(candidate.occurredAt, zone) : null,
      attached: !unreadable.has(candidate.documentId) && !failed.has(candidate.documentId),
    })),
  ]

  const render = (failed: ReadonlySet<string>) =>
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
        costs: totals,
        ledgerBalanceCents: args.closingBalanceCents,
        exhibits: buildExhibits(failed),
        generatedAt: friendlyTimestamp(generatedAt, zone),
        generatedBy,
        timezone: zone,
      }),
      { title: `Eviction case file — ${evictionCase.property.name}` },
    )

  const attachments = [
    { label: 'statement', bytes: new Uint8Array(statementPdf) },
    ...available.map((row) => ({ label: row.candidate.documentId, bytes: new Uint8Array(row.bytes) })),
  ]

  const first = await appendPdfs(await render(new Set()), attachments)

  // AN EXHIBIT THAT ARRIVED BUT WOULD NOT PARSE IS AS ABSENT AS ONE THAT
  // NEVER ARRIVED - and the index has already been rendered claiming it was
  // attached. Photographs make this the common case rather than the rare
  // one: a JPEG is not a PDF and `appendPdfs` correctly refuses it, so the
  // second render is what keeps the index honest about every image in the
  // bundle. One extra pass; the alternative is a document that names
  // attachments it does not contain.
  let bytes = first.bytes
  const failed = new Set(first.failed.filter((label) => label !== 'statement'))
  if (first.failed.length > 0) {
    const parsed = available.filter((row) => !failed.has(row.candidate.documentId))
    const corrected = await appendPdfs(await render(failed), [
      ...(first.failed.includes('statement') ? [] : [{ label: 'statement', bytes: new Uint8Array(statementPdf) }]),
      ...parsed.map((row) => ({ label: row.candidate.documentId, bytes: new Uint8Array(row.bytes) })),
    ])
    bytes = corrected.bytes
  }

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `eviction-packet-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(evictionCase.propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const notAttached = [...new Set([...unreadable, ...failed])]

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
          exhibitsAttached: attachments.length - notAttached.length,
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
