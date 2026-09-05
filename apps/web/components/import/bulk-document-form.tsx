'use client'

import { useActionState, useId } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { bulkUploadDocuments, type BulkDocumentFormState } from '@/lib/import/documents.ts'

const INITIAL: BulkDocumentFormState = {}

/**
 * Bulk document upload keyed by address + type (R-168). One manifest CSV
 * (property_address_line1, property_postal_code, type, file_name) plus the
 * files it names, chosen together in one multi-file picker - the manifest
 * is what turns "forty files" into "forty documents attached to the right
 * property", since a filename alone says nothing about either.
 */
export function BulkDocumentForm() {
  const [state, formAction] = useActionState(bulkUploadDocuments, INITIAL)
  const manifestId = useId()
  const filesId = useId()

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />

      <div className="flex flex-col gap-2">
        <label htmlFor={manifestId} className="text-sm font-medium">
          Manifest CSV
        </label>
        <input
          id={manifestId}
          name="manifest"
          type="file"
          accept=".csv,text/csv"
          className="min-h-11 text-base"
        />
        <p className="text-muted-foreground text-sm">
          Columns: property_address_line1, property_postal_code, type,
          file_name — <code>type</code> is one of the document types (LEASE,
          DEED, INSURANCE_COI, and so on).
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={filesId} className="text-sm font-medium">
          Files
        </label>
        <input id={filesId} name="files" type="file" multiple className="min-h-11 text-base" />
        <p className="text-muted-foreground text-sm">
          Select every file the manifest names — matched by exact filename.
        </p>
      </div>

      {state.results && state.results.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Upload results</caption>
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Line
                </th>
                <th scope="col" className="px-3 py-2">
                  File
                </th>
                <th scope="col" className="px-3 py-2">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {state.results.map((result, i) => (
                <tr key={`${result.line}-${i}`} className="border-t">
                  <td className="px-3 py-2">{result.line}</td>
                  <td className="px-3 py-2">{result.fileName || '—'}</td>
                  <td className={`px-3 py-2 ${result.status === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
                    {result.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <SubmitButton label="Upload" />
      </div>
    </form>
  )
}
