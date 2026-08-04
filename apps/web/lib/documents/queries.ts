import 'server-only'

import { type DocumentTypeValue, retentionCutoff } from '@rental/core/documents'
import { type Document, prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for Document (DOC-01, R-012). Scoped by ResolvedScope.propertyIds,
// same as every other list in this codebase.

/// Active (not soft-deleted) documents attached directly to a property, or
/// to one of its units when `unitId` is given.
export async function listDocuments(
  propertyId: string,
  scope: ResolvedScope,
  unitId?: string,
): Promise<Document[]> {
  if (!scope.propertyIds.includes(propertyId)) return []
  return prisma.document.findMany({
    where: { propertyId, unitId: unitId ?? null, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

/// Soft-deleted documents still inside their undelete window - the pair to
/// listDocuments(), surfaced separately so a normal list is never cluttered
/// with what staff already asked to remove.
export async function listDeletedDocuments(
  propertyId: string,
  scope: ResolvedScope,
  unitId?: string,
): Promise<Document[]> {
  if (!scope.propertyIds.includes(propertyId)) return []
  return prisma.document.findMany({
    where: { propertyId, unitId: unitId ?? null, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
  })
}

export type DocumentWithProperty = Document & {
  property: { id: string; name: string; legalEntityId: string }
}

export async function getDocument(
  documentId: string,
  scope: ResolvedScope,
): Promise<DocumentWithProperty | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { property: { select: { id: true, name: true, legalEntityId: true } } },
  })
  if (!document || !document.propertyId || !scope.propertyIds.includes(document.propertyId)) {
    return null
  }
  return document as DocumentWithProperty
}

export interface RetentionReview {
  document: Document
  cutoff: Date
}

/**
 * Active documents past their retention window (DOC-05) - a report for a
 * human to act on, not an automated purge. See
 * packages/core/documents/retention.ts for why the reference point is
 * `createdAt` rather than the more precise post-termination/post-decision
 * points DOC-05 describes.
 */
export async function documentsPastRetention(
  scope: ResolvedScope,
  asOf: Date,
): Promise<RetentionReview[]> {
  if (scope.propertyIds.length === 0) return []
  const documents = await prisma.document.findMany({
    where: { propertyId: { in: scope.propertyIds }, deletedAt: null },
  })

  const due: RetentionReview[] = []
  for (const document of documents) {
    const cutoff = retentionCutoff(document.type as DocumentTypeValue, document.createdAt)
    if (cutoff && cutoff <= asOf) due.push({ document, cutoff })
  }
  return due
}
