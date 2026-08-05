import type { Document } from '@rental/db'
import { DeleteForm } from '@/components/documents/delete-form.tsx'
import { RestoreButton } from '@/components/documents/restore-button.tsx'
import { UploadForm } from '@/components/documents/upload-form.tsx'
import { deleteDocument, restoreDocument, uploadDocument } from '@/lib/documents/actions.ts'

const TYPE_LABELS: Record<string, string> = {
  LEASE: 'Lease',
  ADDENDUM: 'Addendum',
  NOTICE: 'Notice',
  INVOICE: 'Invoice',
  INSURANCE_COI: 'Insurance (COI)',
  W9: 'W-9',
  INSPECTION_REPORT: 'Inspection report',
  UNIT_PHOTO: 'Unit photo',
  PROPERTY_PHOTO: 'Property photo',
  SHUTOFF_PHOTO: 'Shutoff photo',
  SCREENING_REPORT: 'Screening report',
  APPLICATION: 'Application',
  OTHER: 'Other',
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Attach/find/version/soft-delete for one entity (DOC-01, PROP-08). Embedded
 * on both the property and unit detail pages - a unit's documents ARE the
 * unit's own photo library (PROP-08), a property's are everything else
 * (insurance, W-9s, notices) that is not specific to one unit.
 */
export async function DocumentsSection({
  propertyId,
  unitId,
  documents,
  deletedDocuments,
  canWrite,
  canDelete,
}: {
  propertyId: string
  unitId?: string
  documents: readonly Document[]
  deletedDocuments: readonly Document[]
  canWrite: boolean
  canDelete: boolean
}) {
  const boundUpload = uploadDocument.bind(null, propertyId, unitId ?? null)

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="text-sm font-semibold">Documents</h2>

      {canWrite && <UploadForm action={boundUpload} />}

      {documents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No documents yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <a
                  href={`/api/documents/${document.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  {document.fileName}
                </a>
                <span className="text-muted-foreground text-xs">
                  {TYPE_LABELS[document.type] ?? document.type} ·{' '}
                  {formatBytes(document.sizeBytes)} ·{' '}
                  {document.createdAt.toISOString().slice(0, 10)}
                  {document.capturedAt &&
                    ` · taken ${document.capturedAt.toISOString().slice(0, 10)}`}
                </span>
              </div>
              {canDelete && (
                <DeleteForm
                  action={deleteDocument.bind(null, document.id)}
                  rowId={document.id}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canDelete && deletedDocuments.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-sm font-medium">
            Recently deleted ({deletedDocuments.length})
          </summary>
          <ul className="flex flex-col divide-y">
            {deletedDocuments.map((document) => (
              <li
                key={document.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="text-muted-foreground">
                  {document.fileName} · deleted{' '}
                  {document.deletedAt?.toISOString().slice(0, 10)}
                </span>
                <RestoreButton action={restoreDocument.bind(null, document.id)} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
