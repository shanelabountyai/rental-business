'use client'

import { useFormStatus } from 'react-dom'
import { pendingButtonProps } from '@/components/auth-form.tsx'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// The property switcher (RPT-01: "filterable by entity", ROLE-04).
//
// A plain <select> rather than a combobox. It is native, keyboard-accessible
// and screen-reader-correct with no work, it is the right control on a phone,
// and a portfolio of 10-50 units does not need type-ahead. shadcn's Select
// would be prettier and would need roving focus, escape handling and an aria
// pattern to match what the browser already does correctly.
//
// ==========================================================================
// A REAL FORM WITH A REAL BUTTON (R-115), not `onChange` + `router.refresh()`.
//
// This sits in the header of EVERY admin page, and it did its whole job in an
// `onChange` handler - so on the first paint of every one of those pages,
// changing the scope did nothing at all, silently, until React had hydrated
// the shell. It also set `disabled={pending}` on the `<select>` the user was
// interacting with, and a focused element that becomes `disabled` is blurred
// by the browser: choosing an option threw the keyboard user back to the top
// of the document (R-107a's defect, hand-copied here).
//
// The visible "Apply" button is the price of working before hydration, and it
// is the same trade R-112 took for the tenant's maintenance wizard. `onChange`
// still submits the form for anyone who has JavaScript, so the button is a
// fallback for almost everybody rather than a step.
// ==========================================================================

export function PropertySwitcher({
  scope,
  onSelect,
}: {
  scope: ResolvedScope
  onSelect: (formData: FormData) => Promise<void>
}) {
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
    <form action={onSelect} className="flex items-center gap-2">
      <label htmlFor="property-scope" className="sr-only">
        Filter by property or entity
      </label>
      <select
        id="property-scope"
        name="scope"
        defaultValue={value}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
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
      <ApplyButton />
    </form>
  )
}

function ApplyButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      {...pendingButtonProps(pending)}
      className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {pending ? 'Working…' : 'Apply filter'}
    </button>
  )
}
