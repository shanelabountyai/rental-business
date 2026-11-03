import { prisma } from '@rental/db'
import { requirePermission } from '@/lib/auth/guard.ts'
import { ORG_EXPORT_JOB, ORG_EXPORT_TTL_MS } from '@/lib/export/org-export.ts'
import { storage } from '@/lib/storage/index.ts'

// The org export's download (R-299). The link is time-limited by the run's
// own `finishedAt`, and it is a session-guarded route rather than a bearer
// URL: the archive is every row the org has, so a forwarded link must not
// open it. Same owner guard as the press that made it.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission('report.financial')
  await requirePermission('staff.manage')
  await requirePermission('audit.read')
  const { id } = await params
  // Another org's id answers exactly as a missing one (ORG-04).
  const run = await prisma.jobRun.findFirst({
    where: { id, orgId: actor.orgId, jobType: ORG_EXPORT_JOB, status: 'SUCCEEDED' },
    select: { finishedAt: true, result: true },
  })
  const storageKey = (run?.result as { storageKey?: string } | null)?.storageKey
  if (!run?.finishedAt || !storageKey) return new Response('Not found', { status: 404 })
  if (Date.now() - run.finishedAt.getTime() > ORG_EXPORT_TTL_MS) {
    return new Response('This download link has expired. Make a new export.', { status: 410 })
  }
  const bytes = await storage.get(storageKey)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="org-export-${id}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
