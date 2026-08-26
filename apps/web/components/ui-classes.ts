// Shared class strings for controls that are NOT the shared components
// (R-107a).
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT IN auth-form.tsx. Thirteen buttons
// across twelve files had hand-copied the same "dark button" class list, and
// every one of them had dropped `focus-visible:ring-ring` on the way. Tailwind
// v4 defaults `--tw-ring-color` to `currentcolor` and `--tw-ring-offset-color`
// to white — so on a `text-background` button the focus ring was a white ring
// behind a white offset gap on a white page, at 1.00:1, with
// `focus-visible:outline-none` having already removed the browser's own. A
// keyboard user had no way to tell where they were. That is a plain WCAG 2.4.7
// failure and it survived thirteen copies because the class list LOOKS like it
// has a focus ring.
//
// It is a plain module with no `'use client'` deliberately: half these call
// sites are server components, and every export of a `'use client'` module
// becomes a client reference rather than the value itself.
//
// Layout is NOT in here. The call sites differ on `self-start` / `w-fit` /
// `flex-1` and that is theirs to keep; what is shared is appearance and focus.

/// The dark, high-emphasis button — "Send", "Record", "New template". Distinct
/// from `SubmitButton`, which is the `bg-primary` one inside a form.
export const PRIMARY_BUTTON_CLASSES =
  'bg-foreground text-background focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-sm font-medium aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'

/// The text input / textarea / select boundary and focus ring (R-115).
///
/// `components/form/field.tsx` owns the labelled primitives, and five forms
/// that need their own layout had hand-copied its private `INPUT_CLASSES`
/// verbatim instead. Five copies of a class list carrying a contrast fix is
/// four places for the next one to be missed - which is the argument this
/// file was created to make about the button.
export const INPUT_CLASSES =
  'border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500'
