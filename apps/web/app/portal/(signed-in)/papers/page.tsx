import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { listTenantDocuments } from '@/lib/portal/queries.ts'

export const metadata = { title: 'Your papers' }

// DOC-03: "As a tenant, I access my documents (lease, notices, receipts) and
// ONLY mine - enforced server-side and verified by permission tests."
//
// The enforcement is in `listTenantDocuments`, which filters in the query,
// and in the download route, which re-checks per request. Nothing on this
// page decides access - a template that hides rows has already sent them.
//
// "Papers", not "Documents": D-10 asks for one word per concept at a low
// reading level, and papers is what people call the things in the drawer.

/// Plain words for the closed vocabulary in packages/core/documents. A type a
/// tenant should never see (a deed, a W-9, an inspection report) has no entry
/// - if one somehow reached this list the fallback shows the file name alone
/// rather than inventing a friendly label for it.
const TYPE_WORDS: Record<string, string> = {
  LEASE: 'Your lease',
  ADDENDUM: 'Added to your lease',
  NOTICE: 'A notice',
  INVOICE: 'A bill',
  APPLICATION: 'Your application',
  SCREENING_REPORT: 'Your screening report',
  UNIT_PHOTO: 'A photo of your home',
  /// R-020: safety information about the tenant's own home, visible under
  /// tenantCanSeeDocument's one unit-scoped exception.
  SHUTOFF_PHOTO: 'Where your shutoffs are',
  OTHER: 'A document',
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function PortalPapersPage() {
  const { scope } = await requireTenantWithScope()
  const documents = await listTenantDocuments(scope)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Your papers</h1>
        <p>
          Your lease and anything else we have sent you. Only your own papers
          appear here.
        </p>
      </div>

      {documents.length === 0 ? (
        <p>
          You have no papers yet. When we send you something, it will show up
          here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.map((document) => (
            <li key={document.id}>
              <a
                href={`/api/documents/${document.id}/file`}
                // Opens rather than downloads where the browser can display
                // it, which is what somebody checking a date on their lease
                // actually wants. rel is required with target for security -
                // without noopener the opened page can reach back through
                // window.opener.
                target="_blank"
                rel="noopener noreferrer"
                className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {TYPE_WORDS[document.type] ?? document.fileName}
                </span>
                <span className="text-muted-foreground">
                  {document.fileName} · {fileSize(document.sizeBytes)} · opens
                  in a new tab
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <a
        href="/portal/papers/notice"
        className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <span className="font-medium">Moving out?</span>
        <span className="text-muted-foreground">Give notice to vacate</span>
      </a>
    </div>
  )
}
