'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useActionState } from 'react'
import { useFormVersion } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

type DeleteResult = { text: string; error: boolean } | null

const DeleteResultContext = createContext<((result: DeleteResult) => void) | null>(null)

/// The <li> a delete button removes leaves the DOM in the same render pass
/// as the result, so a live region INSIDE that row (the old shape) announces
/// to nobody - the same class of bug FormAlerts documents, one step further.
/// Wrap a list of `DeleteRowButton`s in this so the announcement lives
/// somewhere that survives the row's removal. Context, not a lifted prop,
/// because a button can be nested arbitrarily deep (a mortgage statement's
/// own sub-list) below a server component that cannot hold state itself.
export function DeleteResultRegion({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<DeleteResult>(null)

  return (
    <DeleteResultContext.Provider value={setResult}>
      {children}
      <div role="alert" className="contents">
        {result?.error && (
          <p className="rounded-md border border-danger/35 bg-danger/6 px-3 py-2 text-sm text-danger">
            {result.text}
          </p>
        )}
      </div>
      <div role="status" className="contents">
        {result && !result.error && (
          <p className="text-muted-foreground text-sm">{result.text}</p>
        )}
      </div>
    </DeleteResultContext.Provider>
  )
}

export function DeleteRowButton({
  action,
  label,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  label: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const version = useFormVersion(state)
  const setResult = useContext(DeleteResultContext)

  useEffect(() => {
    if (version === 0 || !setResult) return
    setResult(
      state.error ? { text: state.error, error: true } : { text: `Removed ${label}.`, error: false },
    )
    // `version` is the only thing that should re-run this - `state` is a new
    // object every render and `label`/`setResult` are stable for the row's
    // lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <button
        type="submit"
        aria-label={`Remove ${label}`}
        className="focus-visible:ring-ring text-muted-foreground hover:text-danger min-h-11 rounded-md px-2 text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Remove
      </button>
    </form>
  )
}
