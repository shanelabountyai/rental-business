import { headers } from 'next/headers'
import { orgIdForHost } from '@/lib/auth/org.ts'
import { requestHost } from '@/lib/auth/platform-host.ts'
import { verifyStaffStepUp } from '@/lib/auth/staff-step-up.ts'
import { FINAL_EXPORT_REFUSED, usableFinalExportLink } from '@/lib/org-lifecycle/final-export-link.ts'
import { storage } from '@/lib/storage/index.ts'

// R-300b (D-388): the final export's download. Possession of the emailed link
// AND the owner's authenticator code (`verifyStaffStepUp`, rate limited per
// owner), on the org's own host. A wrong code goes back to the page.

export async function POST(request: Request) {
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  const link = await usableFinalExportLink(token, await orgIdForHost(requestHost(await headers())))
  if (!link) return new Response(FINAL_EXPORT_REFUSED, { status: 404 })
  if (!(await verifyStaffStepUp(link.staffUserId, String(form.get('code') ?? '').trim()))) {
    // Relative, never built from `request.url`: behind the server that reads
    // `localhost`, and CSP's `form-action 'self'` blocks a cross-host redirect.
    return new Response(null, { status: 303, headers: { Location: `/final-export/${encodeURIComponent(token)}?error=code` } })
  }
  const bytes = await storage.get(link.storageKey)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="final-export-${link.orgId}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
