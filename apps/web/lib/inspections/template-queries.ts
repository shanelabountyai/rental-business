import 'server-only'

import { prisma } from '@rental/db'

// Reads for inspection checklist templates (INSP-01, R-068) - portfolio-wide,
// the same scoping (none) documents/template-queries.ts gives DocumentTemplate
// for the identical reason: a checklist is not owned by one property.

// R-285b: portfolio-wide means the actor's org - every read names it.
export async function listInspectionTemplates(orgId: string) {
  return prisma.inspectionTemplate.findMany({
    where: { orgId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
}

export async function getInspectionTemplate(id: string, orgId: string) {
  return prisma.inspectionTemplate.findFirst({ where: { id, orgId } })
}
