// Form fields for the admin shell's data-entry screens (R-008 onward).
//
// Separate from components/auth-form.tsx on purpose: auth screens are one or
// two fields with a single banner error, tested and stable, and not worth
// risking for a property form with ten fields and several selects. These add
// what that flow does not need - a per-field error tied to the input with
// aria-describedby, and a select/datalist variant - while keeping the same
// accessibility baseline: a real <label>, min-h-11 targets, visible focus
// rings.

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="text-sm text-red-700 dark:text-red-400">
      {message}
    </p>
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
}) {
  const id = `field-${name}`
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

export function SelectField({
  label,
  name,
  required = false,
  defaultValue,
  error,
  options,
  placeholder = 'Select…',
}: {
  label: string
  name: string
  required?: boolean
  defaultValue?: string
  error?: string
  options: readonly { value: string; label: string }[]
  placeholder?: string
}) {
  const id = `field-${name}`
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
