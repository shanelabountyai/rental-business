'use server'

import { createHash } from 'node:crypto'
import type { PacketExhibit } from '@rental/core/documents'
import {
  estoppelCertificateBlocks,
  handoffPacketBlocks,
  depositTotalCents,
} from '@rental/core/property'
import { businessDate, friendlyDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { appendPdfs, renderBlocksPdf } from '@/lib/pdf/render.ts'
import { handoffSource } from '@/lib/properties/handoff-file.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// The sale / acquisition handoff (DOC-06, RISK-09; R-092).
//
// ==========================================================================
// TWO ACTIONS, NOT ONE BUTTON, and the split is R-081d's precedent applied
// rather than a preference. Producing a document a TENANT is asked to sign is
// a different act from assembling a file for a BUYER, and folding them
// together would mean either regenerating every certificate on every export
// (so the one the tenant already signed stops matching the one in the
// packet's index) or silently reusing a stale one. Kept apart, the packet
// attaches whatever certificates exist and NAMES the tenancies with none,
// which is D-50 doing real work instead of being a comment.
//
// BOTH ARE BEHIND `property.export`, WHICH IS PRIVILEGED. Every fact in here
// is already readable by a manager on the screen it came from; what these add
// is one portable file that leaves the building. See the permission's own
// comment for why that earns MFA when reading a rent roll does not.
// ==========================================================================

export interface HandoffState {
  error?: string
  notice?: string
  documentId?: string
}

async function propertyForExport(propertyId: string) {
  // `requireScope` first, never a resource-less `requirePermission` - R-103's
  // lesson, and the scoped read is what decides.
  const { actor } = await requireScope('property.export')
  const scope = await currentScope(actor)
  const source = await handoffSource(propertyId, scope)
  if (!source) return null
  // THEN the real authorization, against this property.
  await requirePermission('property.export', {
    propertyId: source.propertyId,
    legalEntityId: source.legalEntityId,
  })
  return { source, actor }
}

/**
 * Generates one estoppel certificate per running tenancy.
 *
 * REGENERATING REPLACES NOTHING. Each run archives a fresh `Document` through
 * `generateStorageKey`, the same call R-081d makes: a certificate is a claim
 * about a tenancy on a date, and a deterministic key would have the second
 * run overwrite the copy a tenant may already have signed. The packet's index
 * takes the newest per tenancy.
 */
export async function generateEstoppelCertificates(
  propertyId: string,
  _previous: HandoffState,
  _formData: FormData,
): Promise<HandoffState> {
  const context = await propertyForExport(propertyId)
  if (!context) return { error: 'That property is not available.' }
  const { source, actor } = context

  if (source.leases.length === 0) {
    return {
      error:
        'No tenancy is running at this property, so there is nobody to certify anything. A vacant house needs no estoppel.',
    }
  }

  const generatedAt = new Date()
  const zone = source.timezone
  const staff = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { name: true },
  })
  const generatedBy = staff?.name ?? 'Not recorded'

  const created: { leaseId: string; documentId: string }[] = []
  for (const lease of source.leases) {
    const blocks = estoppelCertificateBlocks({
      lease,
      addressLine1: source.addressLine1,
      city: source.city,
      state: source.state,
      postalCode: source.postalCode,
      entityName: source.entityName,
      generatedAt: friendlyTimestamp(generatedAt, zone),
      generatedBy,
      timezone: zone,
    })
    const buffer = Buffer.from(
      await renderBlocksPdf(blocks, {
        title: `Tenant estoppel certificate — ${source.addressLine1} ${lease.unitName}`,
      }),
    )
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const fileName = `estoppel-${lease.leaseId}-${businessDate(generatedAt, zone)}.pdf`
    const storageKey = generateStorageKey(propertyId, fileName)
    // Object before row, the same order every other archiver here uses.
    await storage.put(storageKey, buffer, 'application/pdf')

    const documentId = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          propertyId,
          leaseId: lease.leaseId,
          // No `tenantId`: the certificate is about the tenancy and carries
          // every tenant on it, and picking one of two to hang it from would
          // make it invisible on the other's record.
          type: 'ESTOPPEL_CERTIFICATE',
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
          action: 'lease.estoppel_generated',
          entityType: 'Lease',
          entityId: lease.leaseId,
          propertyId,
          after: {
            documentId: document.id,
            // What was REPRESENTED, alongside the document that represented
            // it. A tenant who later says the rent was different is disputing
            // these three numbers, on this date.
            rentCents: lease.rentCents,
            depositHeldCents: lease.depositHeldCents,
            balanceCents: lease.balanceCents,
            sha256,
          },
        },
        tx,
      )
      return document.id
    })
    created.push({ leaseId: lease.leaseId, documentId })
  }

  revalidatePath(`/properties/${propertyId}`)
  return {
    notice: `${created.length} estoppel ${created.length === 1 ? 'certificate' : 'certificates'} generated — one per running tenancy. Each has to be signed by the tenant; nothing here asks them for it.`,
  }
}

/**
 * Assembles the whole property file into one archived PDF.
 *
 * ASSEMBLY, NOT NEW MACHINERY - R-083's call, then R-081d's, and now this.
 * The queries already exist, `handoffPacketBlocks` already decides what the
 * page says, and `renderBlocksPdf`/`appendPdfs` already draw and bundle.
 */
export async function archiveHandoffPacket(
  propertyId: string,
  _previous: HandoffState,
  _formData: FormData,
): Promise<HandoffState> {
  const context = await propertyForExport(propertyId)
  if (!context) return { error: 'That property is not available.' }
  const { source, actor } = context

  const generatedAt = new Date()
  const zone = source.timezone
  const [staff, certificates] = await Promise.all([
    prisma.staffUser.findUnique({ where: { id: actor.id }, select: { name: true } }),
    prisma.document.findMany({
      where: {
        propertyId,
        type: 'ESTOPPEL_CERTIFICATE',
        leaseId: { in: source.leases.map((lease) => lease.leaseId) },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, leaseId: true, storageKey: true, createdAt: true },
    }),
  ])
  const generatedBy = staff?.name ?? 'Not recorded'

  // Newest per tenancy. `orderBy desc` plus first-wins is the whole of it -
  // regenerating a certificate does not delete the previous one (see the
  // action above), so without this the index would list every historic copy.
  const newest = new Map<string, (typeof certificates)[number]>()
  for (const document of certificates) {
    if (document.leaseId && !newest.has(document.leaseId)) newest.set(document.leaseId, document)
  }

  // EVERY RUNNING TENANCY GETS A ROW, attached or not (D-50). A packet
  // silently missing the one certificate a buyer needed is worse than one
  // that says which is missing.
  const candidates = source.leases.map((lease) => ({
    lease,
    document: newest.get(lease.leaseId) ?? null,
  }))

  const fetched = await Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate.document) return { candidate, bytes: null }
      try {
        return { candidate, bytes: await storage.get(candidate.document.storageKey) }
      } catch {
        // A storage miss is a named gap, never a failed export - one
        // unreadable certificate must not cost the owner the whole packet.
        return { candidate, bytes: null }
      }
    }),
  )
  const available = fetched.filter(
    (row): row is { candidate: (typeof candidates)[number]; bytes: Buffer } => row.bytes !== null,
  )
  const unreadable = new Set(
    fetched.filter((row) => row.bytes === null).map((row) => row.candidate.lease.leaseId),
  )

  // ONE BUILDER, parameterized by what actually made it in - two copies of
  // the fact-building drift, and the second render prints a stale index.
  const buildExhibits = (failed: ReadonlySet<string>): PacketExhibit[] =>
    fetched.map(({ candidate }) => ({
      label: `${candidate.lease.unitName} — ${candidate.lease.tenantNames.join(', ')}`,
      kind: 'Tenant estoppel certificate',
      occurredOn: candidate.document ? friendlyDate(candidate.document.createdAt, zone) : null,
      attached:
        candidate.document != null &&
        !unreadable.has(candidate.lease.leaseId) &&
        !failed.has(candidate.lease.leaseId),
    }))

  const render = (failed: ReadonlySet<string>) =>
    renderBlocksPdf(
      handoffPacketBlocks({
        ...source,
        exhibits: buildExhibits(failed),
        generatedAt: friendlyTimestamp(generatedAt, zone),
        generatedBy,
        timezone: zone,
      }),
      { title: `Property handoff packet — ${source.propertyName}` },
    )

  const first = await appendPdfs(
    await render(new Set()),
    available.map((row) => ({
      label: row.candidate.lease.leaseId,
      bytes: new Uint8Array(row.bytes),
    })),
  )

  // A certificate that arrived but would not parse is as absent as one that
  // never arrived, and the index has already been rendered claiming it was
  // attached. The second render is what keeps the index honest.
  let bytes = first.bytes
  const failed = new Set(first.failed)
  if (failed.size > 0) {
    const parsed = available.filter((row) => !failed.has(row.candidate.lease.leaseId))
    const corrected = await appendPdfs(
      await render(failed),
      parsed.map((row) => ({
        label: row.candidate.lease.leaseId,
        bytes: new Uint8Array(row.bytes),
      })),
    )
    bytes = corrected.bytes
  }

  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `handoff-packet-${source.propertyName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${businessDate(generatedAt, zone)}.pdf`
  const storageKey = generateStorageKey(propertyId, fileName)
  await storage.put(storageKey, buffer, 'application/pdf')

  const notAttached = candidates
    .filter(
      (candidate) =>
        !candidate.document ||
        unreadable.has(candidate.lease.leaseId) ||
        failed.has(candidate.lease.leaseId),
    )
    .map((candidate) => candidate.lease.leaseId)

  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        propertyId,
        // No `leaseId` and no `tenantId`: the packet is about the house, and
        // hanging it off one of three tenancies would be a false claim about
        // which. Same call the tax packet makes at entity level.
        type: 'HANDOFF_PACKET',
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
        action: 'property.handoff_packet_archived',
        entityType: 'Property',
        entityId: propertyId,
        propertyId,
        after: {
          documentId: document.id,
          // The claim the packet makes, recorded alongside it - a packet is a
          // statement about the file on a date, and the file keeps moving.
          leaseCount: source.leases.length,
          depositHeldCents: depositTotalCents(source.leases),
          accessCodeCount: source.accessCodes.length,
          vendorJobCount: source.vendorJobs.length,
          // The TRUE outcome, not the hoped-for one. The audit row and the
          // packet's own index have to agree about what is in the file.
          estoppelsAttached: fetched.length - notAttached.length,
          estoppelsNotAttached: notAttached,
          sha256,
        },
      },
      tx,
    )
    return document.id
  })

  revalidatePath(`/properties/${propertyId}`)
  return {
    notice:
      notAttached.length > 0
        ? `Packet archived. ${notAttached.length} ${notAttached.length === 1 ? 'tenancy is' : 'tenancies are'} named on the exhibit index with no estoppel certificate attached.`
        : 'Packet archived.',
    documentId,
  }
}
