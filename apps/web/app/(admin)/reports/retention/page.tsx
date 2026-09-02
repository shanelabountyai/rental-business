import { DOCUMENT_TYPE_LABELS, type DocumentTypeValue } from '@rental/core/documents'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { documentsPastRetention } from '@/lib/documents/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Retention review — Rental Operations' }

// R-148: DOC-05's retention report, unread since R-081-era code wrote it.
// A report for a HUMAN to act on, never an automated purge - the reader's
// own header says so, and the purge that DOC-05 rules out stays ruled out.
// Scoped like every report: the actor sees documents on properties they can
// see, nothing else.
export default async function RetentionReviewPage() {
  const { actor } = await requireScope('document.read')
  const scope = await currentScope(actor)
  const due = await documentsPastRetention(scope, new Date())
  const propertyNames = new Map(scope.availableProperties.map((p) => [p.id, p.name]))

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Retention review</h1>
        <p className="text-muted-foreground text-sm">
          Documents past their retention window (DOC-05). A list for a person
          to review and act on — nothing here is deleted automatically.
        </p>
      </header>

      {due.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing is past its retention window for the properties you can see.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {due.map(({ document, cutoff }) => (
            <li key={document.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{document.fileName}</span>
                <span className="text-muted-foreground">
                  window ended{' '}
                  {friendlyBusinessDate(utcToBusinessDate(cutoff))}
                </span>
              </div>
              <p className="text-muted-foreground">
                {DOCUMENT_TYPE_LABELS[document.type as DocumentTypeValue] ?? document.type}
                {document.propertyId
                  ? ` · ${propertyNames.get(document.propertyId) ?? 'Unknown property'}`
                  : ''}
                {' · uploaded '}
                {friendlyBusinessDate(utcToBusinessDate(document.createdAt))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
