'use client'

import type { ReactNode } from 'react'
import { useActionState, useEffect, useRef, useState } from 'react'
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

/**
 * The submit button behind ~108 forms, and the reason it is `aria-disabled`
 * rather than `disabled` (R-107a).
 *
 * A FOCUSED ELEMENT THAT BECOMES `disabled` IS BLURRED BY THE BROWSER. Every
 * one of those forms therefore threw keyboard focus to `<body>` the instant
 * it was submitted: the keyboard user's next Tab restarted at the top of the
 * document, and the screen-reader user's cursor was thrown to the start of
 * the page — on every single press, on every form in the product.
 *
 * Worse, it was silent. `disabled` also removes the element from the
 * accessibility tree, so the swap to "Working…" — the only feedback the press
 * produced — was announced to nobody, and `FormAlerts` then announced the
 * RESULT into a region the user was no longer anywhere near.
 *
 * `aria-disabled` keeps the button focused and in the tree, so the name
 * change IS spoken, and `aria-busy` says what kind of change it is. The click
 * guard is what actually prevents the second submit, which is the only thing
 * `disabled` was doing for us that mattered.
 *
 * NO `opacity-60` EITHER. `bg-primary`/`text-primary-foreground` faded to 60%
 * over white composites to about 2.2:1, so the pending label was the least
 * readable thing on the screen at the exact moment it was the only thing
 * worth reading. The label change and the cursor carry the state instead.
 */
/// `label` is a `ReactNode` so a caller can hide the disambiguating half of a
/// name from the eye without hiding it from the ear (R-115): a per-row
/// "Delete" that must be "Delete {fileName}" to assistive technology, in a row
/// already printing that filename, is `Delete<span className="sr-only">
/// {fileName}</span>`. 2.5.3 wants the visible label CONTAINED in the
/// accessible name, which that is.
export function SubmitButton({ label }: { label: ReactNode }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      {...pendingButtonProps(pending)}
      className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-base font-medium aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {pending ? 'Working…' : label}
    </button>
  )
}

/**
 * The same contract for a submit button that cannot be `SubmitButton` (R-115).
 *
 * `SubmitButton` hard-codes its label and its `bg-primary` styling, so a
 * dozen buttons across the product are hand-rolled: the `PRIMARY_BUTTON_CLASSES`
 * ones, and the on-call rota's row of `name="hours"` submits where the whole
 * point is WHICH button was pressed. Every one of them had hand-copied
 * `disabled={pending}` — the exact defect R-107a fixed in `SubmitButton` and
 * documented above — so the audit found the fix undone at eight call sites the
 * day after it landed.
 *
 * Spread this instead. It is the three attributes and nothing else: no label,
 * no classes, no layout, so a caller keeps the parts that are genuinely its
 * own. Drop `disabled:opacity-60` with it — see the "NO opacity-60" paragraph
 * above.
 */
export function pendingButtonProps(pending: boolean) {
  return {
    'aria-disabled': pending || undefined,
    'aria-busy': pending || undefined,
    onClick: (event: { preventDefault: () => void }) => {
      if (pending) event.preventDefault()
    },
  }
}

/**
 * A live region that is always in the accessibility tree, whatever it holds.
 *
 * For the announcements that are NOT a form's error/notice pair — a card fee
 * appearing, an autopay day confirmed, a panel swapping to "thank you". Those
 * were each written as `{condition && <p role="status">…}`, which is the same
 * defect `FormAlerts` above documents: the region arrives already-populated,
 * so there is no change to announce and assistive technology says nothing.
 *
 * `assertive` only where the user cannot proceed without reading it. A fee
 * that changes what somebody is about to be charged is polite-but-important,
 * not an interruption.
 */
/**
 * Moves focus to an element the first time `when` becomes true (R-101d).
 *
 * ==========================================================================
 * FOR A PANEL THAT REPLACES ITSELF, which a live region cannot help with.
 *
 * Three panels in this product swap their whole section on success — the
 * tenant's "was this fixed?", the inherited-lease intake, MFA enrolment — and
 * each put `role="status"` on the content that replaced its own container.
 * That announces nothing: a live region inside a replaced container is a new
 * node either way, so there is no change to report. Worse, the control that
 * had focus was just unmounted, so focus falls to `<body>` — a keyboard user
 * is returned to the top of the document and a screen reader says nothing at
 * all about what happened.
 *
 * Focusing the new heading announces the WHOLE new context — the heading, the
 * section it labels, and the text under it — rather than one sentence of it.
 *
 * `when` MUST be driven by client action state, never by a server prop.
 * All three panels also render their done-state on an ordinary page load (a
 * lease whose gaps were settled last week, a job answered yesterday), and
 * focusing then would yank focus away from somebody who had simply navigated
 * to the page. The distinction is "something just happened" versus "something
 * happened once" - only the first is worth interrupting for.
 *
 * Fires ONCE. Re-focusing on a later re-render would fight the user for
 * control of their own cursor.
 * ==========================================================================
 */
export function useFocusWhen<T extends HTMLElement>(when: boolean) {
  const ref = useRef<T>(null)
  const fired = useRef(false)
  useEffect(() => {
    if (!when || fired.current) return
    fired.current = true
    ref.current?.focus()
  }, [when])
  return ref
}

/**
 * A `key` for an uncontrolled form that has to hand back what was typed
 * (R-114, extracted from `property-form.tsx`'s R-008 fix).
 *
 * ==========================================================================
 * REACT 19 RESETS AN UNCONTROLLED FORM'S FIELDS AFTER EVERY ACTION DISPATCH,
 * success or refusal alike - so by the time a validation error comes back the
 * DOM has already forgotten what the user typed, and a `defaultValue` handed
 * back in the action's state lands on inputs React has no reason to re-mount.
 * Bumping this and using it as the form's `key` throws those now-empty inputs
 * away and mounts fresh ones whose `defaultValue` is the echoed value.
 *
 * Bumped during render (comparing against a stored previous `state`), not in
 * an effect: React's own guidance for "adjust state when a prop changes" is
 * this setState-during-render escape hatch, which - unlike an effect - applies
 * before the browser paints, so there is no visible flash of empty fields.
 * `react-hooks/set-state-in-effect` flags the effect-based version.
 *
 * MOUNT EVERY LIVE REGION OUTSIDE THE KEYED FORM. A `key` on a `<form>` throws
 * its whole subtree away on every response, so a `FormAlerts` inside it is a
 * brand-new node every time and announces nothing - which is precisely the
 * defect R-101 fixed and this remount silently undid on `property-form.tsx`
 * until R-107b caught it. A control that has to submit the form from outside
 * reaches it with the native `form=` attribute and a `useId()` id.
 * ==========================================================================
 */
export function useFormVersion(state: unknown): number {
  const [previousState, setPreviousState] = useState(state)
  const [version, setVersion] = useState(0)
  if (state !== previousState) {
    setPreviousState(state)
    setVersion((current) => current + 1)
  }
  return version
}

export function LiveRegion({
  children,
  assertive = false,
}: {
  children?: ReactNode
  assertive?: boolean
}) {
  return (
    // `display: contents` for the same reason as FormAlerts: these sit inside
    // flex columns with a gap, and an always-present empty box would push
    // every screen it appears on.
    <div role={assertive ? 'alert' : 'status'} className="contents">
      {children}
    </div>
  )
}

/**
 * The form's two live regions: `alert` for failures (assertive, because the
 * user cannot proceed) and `status` for confirmations (polite).
 *
 * ==========================================================================
 * THE REGIONS ARE ALWAYS RENDERED, AND THAT IS THE WHOLE FIX (R-101).
 *
 * This used to insert the region and its text together — `{state.error && <p
 * role="alert">…}` — and its own comment said the message was "announced on
 * arrival". It generally was not. A live region announces CHANGES TO ITSELF,
 * so it has to be in the accessibility tree BEFORE the text lands in it. A
 * region that appears already-populated is a new node, not a change, and
 * assistive technology routinely says nothing at all.
 *
 * That is one bug in one file reaching 49 components — every form in the
 * product, including the ones a tenant uses to report a leak and pay rent.
 * It is invisible to axe, which scans a static snapshot and cannot know
 * whether anything was ever spoken.
 *
 * `display: contents` on the wrappers, so the always-present regions
 * contribute no box: their parents are `flex flex-col gap-*`, and an empty
 * div would otherwise add a phantom gap above every form on every screen.
 * ==========================================================================
 */
export function FormAlerts({ state }: { state: FormState }) {
  return (
    <>
      <div role="alert" className="contents">
        {state.error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            {state.error}
          </p>
        )}
      </div>
      <div role="status" className="contents">
        {state.notice && (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {state.notice}
          </p>
        )}
      </div>
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
