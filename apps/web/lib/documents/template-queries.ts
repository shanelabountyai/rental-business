import 'server-only'

import { DOCUMENT_TYPES } from '@rental/core/documents'
import { prisma } from '@rental/db'

// Reads for document templates (DOC-04, R-062) - portfolio-wide, the same
// scoping (none) `comms/templates.ts` gives MessageTemplate for the
// identical reason: a template is not owned by one property. A separate
// file from `documents/queries.ts` (Document itself, R-012) on purpose -
// different entity, different scoping shape (that one is property-scoped;
// this one is not).

export async function listDocumentTemplates() {
  return prisma.documentTemplate.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
}

export async function getDocumentTemplate(id: string) {
  return prisma.documentTemplate.findUnique({ where: { id } })
}

/// For the template form's document-type picker - every closed type this
/// build recognizes, not just the two R-062 added. A plain constant, kept
/// OUT of template-actions.ts - a 'use server' file may only export async
/// functions (CLAUDE.md's own trap: passes typecheck and vitest, fails
/// `next build`).
export const DOCUMENT_TYPE_OPTIONS = DOCUMENT_TYPES.map((value) => ({ value, label: value }))
