import 'server-only'

import { prisma } from '@rental/db'

// Reads for inspection checklist templates (INSP-01, R-068) - portfolio-wide,
// the same scoping (none) documents/template-queries.ts gives DocumentTemplate
// for the identical reason: a checklist is not owned by one property.

export async function listInspectionTemplates() {
  return prisma.inspectionTemplate.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
}

export async function getInspectionTemplate(id: string) {
  return prisma.inspectionTemplate.findUnique({ where: { id } })
}
