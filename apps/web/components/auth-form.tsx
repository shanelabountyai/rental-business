'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

// Shared chrome for every auth screen. Not a component library - R-007 brings
// shadcn in properly with the admin shell. This exists so the accessibility
// details are written once instead of six times, because they are the part
// most likely to be dropped under time pressure:
//
//   - every input has a real <label>, not a placeholder pretending to be one
//   - errors are role="alert" so a screen reader announces them on arrival
//   - the error is tied to the field with aria-describedby / aria-invalid
//   - the submit button reports its own pending state rather than going dead
//
// WCAG 2.1 AA is an acceptance criterion on tenant-facing work (CLAUDE.md),
// and the tenant sign-in page is the first tenant-facing thing in the product.

export interface FormState {
  error?: string
  notice?: string
}

export function Field({
  label,
  name,
  type = 'text',
  autoComplete,
  required = true,
  inputMode,
  pattern,
  describedBy,
  invalid,
  defaultValue,
  autoFocus,
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  required?: boolean
  inputMode?: 'numeric' | 'email' | 'text'
  pattern?: string
  describedBy?: string
  invalid?: boolean
  defaultValue?: string
  autoFocus?: boolean
}) {
  const id = `field-${name}`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        pattern={pattern}
        defaultValue={defaultValue}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      />
    </div>
  )
}

export function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-base font-medium disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {pending ? 'Working…' : label}
    </button>
  )
}

/// Announced on arrival: role="alert" for failures (assertive, because the
/// user cannot proceed), role="status" for confirmations (polite).
export function FormAlerts({ state }: { state: FormState }) {
  return (
    <>
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {state.error}
        </p>
      )}
      {state.notice && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
        >
          {state.notice}
        </p>
      )}
    </>
  )
}

/// Plain FormState, not a generic. A flow whose action returns more than an
/// error or a notice - MFA enrolment, which has to hand back recovery codes -
/// owns its own useActionState and composes Field/FormAlerts/SubmitButton
/// directly. That is less machinery than making this generic enough for both.
export function AuthForm({
  action,
  submitLabel,
  children,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  children: React.ReactNode
}) {
  const [state, formAction] = useActionState(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      {children}
      <SubmitButton label={submitLabel} />
    </form>
  )
}

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </header>
      {children}
      {footer && <div className="text-muted-foreground text-sm">{footer}</div>}
    </main>
  )
}
