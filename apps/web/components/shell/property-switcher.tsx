'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// The property switcher (RPT-01: "filterable by entity", ROLE-04).
//
// A plain <select> rather than a combobox. It is native, keyboard-accessible
// and screen-reader-correct with no work, it is the right control on a phone,
// and a portfolio of 10-50 units does not need type-ahead. shadcn's Select
// would be prettier and would need roving focus, escape handling and an aria
// pattern to match what the browser already does correctly.

export function PropertySwitcher({
  scope,
  onSelect,
}: {
  scope: ResolvedScope
  onSelect: (value: string) => Promise<void>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const value =
    scope.selection.kind === 'all'
      ? 'all'
      : scope.selection.kind === 'entity'
        ? `entity:${scope.selection.legalEntityId}`
        : `property:${scope.selection.propertyId}`

  // An actor with one property has nothing to switch between; a control with
  // one option is noise.
  if (!scope.switchable) return null

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="property-scope" className="sr-only">
        Filter by property or entity
      </label>
      <select
        id="property-scope"
        name="scope"
        defaultValue={value}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value
          startTransition(async () => {
            await onSelect(next)
            // The selection changes what every scoped query below returns, so
            // the whole tree has to re-render rather than just this control.
            router.refresh()
          })
        }}
        className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        <option value="all">All properties</option>

        {scope.availableEntities.length > 1 && (
          <optgroup label="Entities">
            {scope.availableEntities.map((entity) => (
              <option key={entity.id} value={`entity:${entity.id}`}>
                {entity.name}
              </option>
            ))}
          </optgroup>
        )}

        <optgroup label="Properties">
          {scope.availableProperties.map((property) => (
            <option key={property.id} value={`property:${property.id}`}>
              {property.name}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  )
}
