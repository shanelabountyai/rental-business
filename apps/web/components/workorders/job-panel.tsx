import Link from 'next/link'

// The "full context" MAINT-03 asks the in-house job list to carry: photos,
// appliance data, filter sizes, codes, tenant phone. Read-only, alongside
// the SAME generic claim/complete/cancel controls every other task type
// gets - unlike R-023's triage panel, completing this task does not itself
// change the work order's own status. Verifying and closing out real work
// (labor, materials, invoice, tenant sign-off) is R-030's build; this is
// what a tech needs to actually do the job, not to close it out.
export function JobPanel({
  workOrder,
  context,
}: {
  workOrder: {
    id: string
    scope: string
    unitId: string
    propertyId: string
  }
  context: {
    operational: {
      appliances: readonly {
        id: string
        category: string
        make: string | null
        model: string | null
        serialNumber: string | null
        filterSize: string | null
      }[]
      accessCodes: readonly { id: string; type: string; label: string | null }[]
    } | null
    photos: readonly { id: string; fileName: string }[]
    tenantPhone: string | null
  }
}) {
  return (
    <div className="flex flex-col gap-6 rounded-md border p-4">
      <p className="whitespace-pre-wrap text-sm">{workOrder.scope}</p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Tenant phone</dt>
        <dd className="col-span-1 sm:col-span-2">{context.tenantPhone ?? 'None on file'}</dd>
      </div>

      {context.photos.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Photos</p>
          <ul className="flex flex-col gap-1 text-sm">
            {context.photos.map((photo) => (
              <li key={photo.id}>
                <Link
                  href={`/api/documents/${photo.id}/file`}
                  className="underline underline-offset-4"
                >
                  {photo.fileName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {context.operational && context.operational.appliances.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Appliances</p>
          <ul className="flex flex-col gap-1 text-sm">
            {context.operational.appliances.map((a) => (
              <li key={a.id} className="text-muted-foreground">
                {a.category}
                {a.make && ` — ${a.make}`}
                {a.model && ` ${a.model}`}
                {a.serialNumber && ` (SN ${a.serialNumber})`}
                {a.filterSize && ` · filter ${a.filterSize}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {context.operational && context.operational.accessCodes.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Access</p>
          <ul className="flex flex-col gap-1 text-sm">
            {context.operational.accessCodes.map((code) => (
              <li key={code.id} className="text-muted-foreground">
                {code.label ?? code.type} —{' '}
                <Link
                  href={`/properties/${workOrder.propertyId}/units/${workOrder.unitId}`}
                  className="underline underline-offset-4"
                >
                  reveal on the unit page
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
