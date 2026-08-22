'use server'

import { createHash } from 'node:crypto'
import type { PacketExhibit } from '@rental/core/documents'
import { businessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { type AccountingBasis, isAccountingBasis, taxPacketBlocks } from '@rental/core/tax'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { appendPdfs, renderBlocksPdf } from '@/lib/pdf/render.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { taxPacket } from '@/lib/tax/packet.ts'

// The tax packet as an archived artifact (RPT-07, R-081d).
//
// ASSEMBLY, NOT NEW MACHINERY - the same call R-083 made. `taxPacket()`
// already computes every figure, `taxPacketBlocks()` already lays them out,
// and `renderBlocksPdf`/`appendPdfs` already draw and bundle. What did not
// exist is the one file somebody hands the preparer, kept exactly as handed.
//
// WHAT IS ATTACHED, AND THE RULE BEHIND IT. Only the Form 1098s. Every other
// schedule in the packet is derived from records this system holds and can
// reproduce on demand; a 1098 is a figure TRANSCRIBED OFF A FORM THIS PRODUCT
// NEVER SAW, so the form itself is the only evidence in the bundle that could
// not be regenerated from the database. Padding it with every invoice behind
// every repair line would make a packet nobody reads to the end - the same
// reasoning that kept EXHIBIT_TYPES narrow on the attorney packet.
//
// D-50 GOVERNS THE INDEX. A 1098 with no uploaded form, or one whose bytes
// will not parse, is NAMED on the index and on the audit row, never silently
// absent. R-081b left "no document upload for the 1098" behind deliberately;
// this is what makes that gap visible on the artifact instead of invisible.

export interface ArchiveState {
  error?: string
  notice?: string
  documentId?: string
}

interface Exhibit1098 {
  statementId: string
  documentId: string | null
  label: string
  recordedOn: Date
}

export async function archiveTaxPacket(
  _previous: ArchiveState,
  formData: FormData,
): Promise<ArchiveState> {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)

  const legalEntityId = String(formData.get('entity') ?? '')
  const year = Number(formData.get('year'))
  const basisRaw = String(formData.get('basis') ?? 'cash')
  const basis: AccountingBasis = isAccountingBasis(basisRaw) ? basisRaw : 'cash'
  if (!legalEntityId || !Number.isInteger(year)) {
    return { error: 'Choose an entity and a year first.' }
  }

  // The entity-scoped check, not a resource-less one: an entity-scoped manager
  // holds `report.financial` over their own LLC and nothing else, and
  // `assignmentCovers` only ever matches the branch it is given.
  await requirePermission('report.financial', { legalEntityId })

  const packet = await taxPacket(scope, legalEntityId, year, basis)
  // Null means out of scope, and out of scope answers the same as absent
  // (ROLE-01) - never a message confirming the entity exists.
  if (!packet) return { error: 'That entity is not available.' }

  const generatedAt = new Date()
  // ONE ZONE FOR THE WHOLE ARTIFACT, and it is the actor's own display zone
  // rather than any property's. A packet spans an entity whose houses can sit
  // in several zones (D-3), so there is no property clock to read "produced
  // at" in; the packet's own figures are already per-property-zone correct
  // upstream, and this timestamp is about the act of producing the file.
  const zone = 'UTC'

  const [staff, statements] = await Promise.all([
    prisma.staffUser.findUnique({ where: { id: actor.id }, select: { name: true } }),
    prisma.mortgageAnnualStatement.findMany({
      where: { taxYear: year, mortgage: { propertyId: { in: scope.propertyIds } } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        documentId: true,
        mortgage: {
          select: { lender: true, property: { select: { id: true, name: true, legalEntityId: true } } },
        },
      },
    }),
  ])
  const generatedBy = staff?.name ?? 'Not recorded'

  // Scoped to the entity in code rather than in the where clause: the nested
  // filter above can only reach `propertyId`, and `scope.propertyIds` spans
  // every entity the actor can see.
  const candidates: Exhibit1098[] = statements
    .filter((row) => row.mortgage.property.legalEntityId === legalEntityId)
    .map((row) => ({
      statementId: row.id,
      documentId: row.documentId,
      label: `${row.mortgage.lender} — ${row.mortgage.property.name}`,
      recordedOn: row.createdAt,
    }))

  const keyById = new Map(
    (
      await prisma.document.findMany({
        where: { id: { in: candidates.flatMap((c) => (c.documentId ? [c.documentId] : [])) } },
        select: { id: true, storageKey: true },
      })
    ).map((document) => [document.id, document.storageKey]),
  )

  // A storage miss is a named gap, never a failed export - one unreadable
  // form must not cost the owner the whole packet.
  const fetched = await Promise.all(
    candidates.map(async (candidate) => {
      const key = candidate.documentId ? keyById.get(candidate.documentId) : undefined
      if (!key) return { candidate, bytes: null }
      try {
        return { candidate, bytes: await storage.get(key) }
      } catch {
        return { candidate, bytes: null }
      }
    }),
  )
  const available = fetched.filter(
    (row): row is { candidate: Exhibit1098; bytes: Buffer } => row.bytes !== null,
  )
  const unreadable = new Set(
    fetched.filter((row) => row.bytes === null).map((row) => row.candidate.statementId),
  )

  // ONE BUILDER, parameterized by what actually made it in - the same shape
  // the attorney packet and the ledger statement use, and for the same
  // reason: two copies of the fact-building drift, and the second render
  // silently prints a stale index.
  const buildExhibits = (failed: ReadonlySet<string>): PacketExhibit[] =>
    fetched.map(({ candidate }) => ({
      label: candidate.label,
      kind: `Form 1098 (${year})`,
      occurredOn: friendlyDate(candidate.recordedOn, zone),
      attached: !unreadable.has(candidate.statementId) && !failed.has(candidate.statementId),
    }))

  const render = (failed: ReadonlySet<string>) =>
    renderBlocksPdf(
      taxPacketBlocks({
        legalEntityName: packet.legalEntityName,
        year: packet.year,
        basis: packet.basis,
        scheduleE: packet.scheduleE,
        capex: packet.capex,
        depositLiability: packet.depositLiability,
        vendors: packet.vendors,
        exceptions: packet.exceptions,
        exceptionCents: packet.exceptionCents,
        exhibits: buildExhibits(failed),
        generatedAt: friendlyTimestamp(generatedAt, zone),
        generatedBy,
        timezone: zone,
      }),
      { title: `Year-end tax packet — ${packet.legalEntityName} ${packet.year}` },
    )

  const first = await appendPdfs(
    await render(new Set()),
    available.map((row) => ({ label: row.candidate.statementId, bytes: new Uint8Array(row.bytes) })),
  )

  // A FORM THAT ARRIVED BUT WOULD NOT PARSE IS AS ABSENT AS ONE THAT NEVER
  // ARRIVED - and the index has already been rendered claiming it was
  // attached. A 1098 is routinely a scan, and a JPEG is not a PDF, so the
  // second render is what keeps the index honest.
  let bytes = first.bytes
  const failed = new Set(first.failed)
  if (failed.size > 0) {
    const parsed = available.filter((row) => !failed.has(row.candidate.statementId))
    const corrected = await appendPdfs(
      await render(failed),
      parsed.map((row) => ({
        label: row.candidate.statementId,
        bytes: new Uint8Array(row.bytes),
      })),
    )
    bytes = corrected.bytes
  }

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `tax-packet-${packet.year}-${packet.basis}-${businessDate(generatedAt, zone)}.pdf`
  // Through the generator, so two packets produced for the same entity and
  // year on the same day get their own objects. A deterministic key would
  // have the second overwrite the first, which is precisely the "each export
  // is separately archived" property this whole item exists for.
  const storageKey = generateStorageKey(legalEntityId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const notAttached = [...new Set([...unreadable, ...failed])]

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        // The ENTITY, not a property. Schedule E splits by address but the
        // deposit and 1099 schedules are entity-wide, so no one house owns
        // this - and a null owner would make it unreachable to everybody.
        legalEntityId,
        // No tenantId and no leaseId, the same call the statement and the
        // attorney packet make: the owner's tax position is not a tenant's
        // to read.
        type: 'TAX_PACKET',
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
        action: 'tax.packet_archived',
        entityType: 'LegalEntity',
        entityId: legalEntityId,
        after: {
          documentId: document.id,
          year: packet.year,
          basis: packet.basis,
          // The claim the packet makes, recorded alongside it - a packet is a
          // statement about the books on a date, and the books keep moving.
          incomeCents: packet.incomeCents,
          expenseCents: packet.expenseCents,
          propertyCount: packet.scheduleE.length,
          exceptionCount: packet.exceptions.length,
          // The TRUE outcome, not the hoped-for one. The audit row and the
          // packet's own index must agree about what is in the file.
          exhibitsAttached: fetched.length - notAttached.length,
          exhibitsNotAttached: notAttached,
          sha256,
        },
      },
      tx,
    )
    return document.id
  })

  return {
    notice:
      notAttached.length > 0
        ? `Packet archived. ${notAttached.length} Form 1098 ${notAttached.length === 1 ? 'is' : 'are'} named on the index but could not be attached.`
        : 'Packet archived.',
    documentId,
  }
}
