// Form fields for the admin shell's data-entry screens (R-008 onward).
//
// Separate from components/auth-form.tsx on purpose: auth screens are one or
// two fields with a single banner error, tested and stable, and not worth
// risking for a property form with ten fields and several selects. These add
// what that flow does not need - a per-field error tied to the input with
// aria-describedby, and a select/datalist variant - while keeping the same
// accessibility baseline: a real <label>, min-h-11 targets, visible focus
// rings.

/**
 * The admin side's error region.
 *
 * ==========================================================================
 * THE REGION IS ALWAYS RENDERED — the same fix R-101 made to `FormAlerts`,
 * applied to the component it missed (R-031).
 *
 * This used to `return null` when there was no message and insert the
 * `role="alert"` element together with its text. A live region announces
 * CHANGES TO ITSELF, so it has to be in the accessibility tree BEFORE the
 * text lands in it; one that appears already-populated is a new node, not a
 * change, and assistive technology routinely says nothing at all.
 *
 * R-101 fixed the tenant-facing twin in `auth-form.tsx` and recorded the
 * reasoning there. This is the primitive every ADMIN form uses for the same
 * job, and it still had the defect — so a PM submitting a form with a
 * keyboard and a screen reader got silence on every validation failure in
 * the back office. Found while adding one more caller (the chargeback panel),
 * which is the only reason it surfaced at all: it is invisible to axe, which
 * scans a static snapshot and cannot know whether anything was spoken.
 *
 * `display: contents` so the always-present wrapper contributes no box — its
 * parents are `flex flex-col gap-*`, and an empty div would add a phantom gap
 * under every field in the product.
 *
 * The `id` stays on the `<p>`, not the wrapper: an `aria-describedby`
 * pointing at an id that does not exist is ignored, which is the correct
 * behaviour when there is no error to describe.
 * ==========================================================================
 */
export function FieldError({ id, message }: { id: string; message?: string }) {
  return (
    <div role="alert" className="contents">
      {message && (
        <p id={id} className="text-sm text-red-700 dark:text-red-400">
          {message}
        </p>
      )}
    </div>
  )
}

const INPUT_CLASSES =
  'border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500'

export function TextField({
  label,
  name,
  type = 'text',
  required = false,
  defaultValue,
  error,
  hint,
  inputMode,
  min,
  max,
  step,
  autoFocus,
  list,
  idPrefix,
  onChange,
}: {
  label: string
  name: string
  type?: string
  required?: boolean
  defaultValue?: string | number
  error?: string
  hint?: string
  inputMode?: 'numeric' | 'decimal' | 'text'
  min?: number | string
  max?: number | string
  step?: number | string
  autoFocus?: boolean
  list?: string
  /// Set when this form shares a field `name` (commonly "type" or "notes")
  /// with another form that can be present on the same page at once - two
  /// <details>-collapsed forms both existing in the DOM simultaneously is
  /// normal on this app's detail pages (documents + operational-data
  /// subsections all live on one unit page), and two inputs sharing one id
  /// is invalid HTML that breaks getByLabel() for every one of them but the
  /// first, the same lesson CheckboxField's `value` param already applies.
  idPrefix?: string
  /// Set only when something outside the form has to react as the user types
  /// - R-049's live template preview is the first. The field stays
  /// UNCONTROLLED either way (`defaultValue`, not `value`), so adding this
  /// changes nothing for the twenty-odd existing callers.
  onChange?: (value: string) => void
}) {
  const id = idPrefix ? `field-${idPrefix}-${name}` : `field-${name}`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {hint && (
        <p id={hintId} className="text-muted-foreground text-sm">
          {hint}
        </p>
      )}
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        inputMode={inputMode}
        min={min}
        max={max}
        step={step}
        list={list}
        autoFocus={autoFocus}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy || undefined}
        className={INPUT_CLASSES}
      />
      <FieldError id={errorId} message={error} />
    </div>
  )
}

/// Same accessible shape as TextField (label, error, hint, idPrefix) for
/// multi-line text - a listing's description or requirements, not a single
/// line INPUT_CLASSES was sized for. Added rather than hand-rolled a third
/// time on the same page (R-056 needed it for description, requirements AND
/// the pet-policy text, all at once).
export function TextareaField({
  label,
  name,
  required = false,
  defaultValue,
  error,
  hint,
  rows = 4,
  idPrefix,
}: {
  label: string
  name: string
  required?: boolean
  defaultValue?: string
  error?: string
  hint?: string
  rows?: number
  idPrefix?: string
}) {
  const id = idPrefix ? `field-${idPrefix}-${name}` : `field-${name}`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {hint && (
        <p id={hintId} className="text-muted-foreground text-sm">
          {hint}
        </p>
      )}
      <textarea
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue}
        rows={rows}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy || undefined}
        className={INPUT_CLASSES}
      />
      <FieldError id={errorId} message={error} />
    </div>
  )
}

export function CheckboxField({
  label,
  name,
  value,
  defaultChecked,
  hint,
  onChange,
}: {
  label: string
  name: string
  /// Set when several checkboxes share one `name` to submit a set of values
  /// (a `formData.getAll(name)` field, e.g. a payment-allocation order) -
  /// otherwise the checkbox submits the default "on" for a plain boolean
  /// field. Folded into `id` too, since several checkboxes sharing one name
  /// would otherwise share one id, which is invalid HTML and breaks the
  /// label-to-input association for every one of them but the first.
  value?: string
  defaultChecked?: boolean
  hint?: string
  /// Same escape hatch as TextField's own `onChange` - something outside
  /// the form needs to react as the box is (un)checked. Stays UNCONTROLLED
  /// (`defaultChecked`, not `checked`) either way.
  onChange?: (checked: boolean) => void
}) {
  const id = value ? `field-${name}-${value}` : `field-${name}`
  const hintId = `${id}-hint`

  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        name={name}
        type="checkbox"
        value={value}
        defaultChecked={defaultChecked}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        aria-describedby={hint ? hintId : undefined}
        // The only control in this file that set no focus classes, so its
        // focus indicator was the base `* { outline-ring }` rule and nothing
        // else - which was `outline-ring/50` until R-107a and computed to
        // 1.54:1. Explicit now, like every sibling here.
        className="border-input focus-visible:ring-ring mt-1 size-5 rounded focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      />
      <label htmlFor={id} className="flex flex-col text-sm">
        <span className="font-medium">{label}</span>
        {hint && (
          <span id={hintId} className="text-muted-foreground">
            {hint}
          </span>
        )}
      </label>
    </div>
  )
}

export function SelectField({
  label,
  name,
  required = false,
  defaultValue,
  error,
  options,
  placeholder = 'Select…',
  idPrefix,
  onChange,
}: {
  label: string
  name: string
  required?: boolean
  defaultValue?: string
  error?: string
  options: readonly { value: string; label: string }[]
  placeholder?: string
  /// See TextField's identical param for why this exists.
  idPrefix?: string
  /// Only for a caller that needs to react to the choice client-side (e.g.
  /// showing a different field below depending on which option is picked) -
  /// the field stays uncontrolled (`defaultValue`, not `value`) either way,
  /// so a form action's own React-19 reset behaviour is unaffected.
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void
}) {
  const id = idPrefix ? `field-${idPrefix}-${name}` : `field-${name}`
  const errorId = `${id}-error`

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ''}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? errorId : undefined}
        className={INPUT_CLASSES}
        onChange={onChange}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldError id={errorId} message={error} />
    </div>
  )
}
