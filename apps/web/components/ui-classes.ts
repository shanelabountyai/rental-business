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

/// The copper button (D-163) - Homestead reserves the accent for the chase
/// affordance, so this is deliberately used in one place today. White on
/// #9A5B32 is 5.36:1. D-163's standing rule applies: this is NEVER an alarm
/// colour - anything urgent is red + icon + words, not copper.
export const ACCENT_BUTTON_CLASSES =
  'bg-accent text-accent-foreground hover:bg-accent-strong focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-sm font-medium aria-disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'

/// The text input / textarea / select boundary and focus ring (R-115).
///
/// `components/form/field.tsx` owns the labelled primitives, and five forms
/// that need their own layout had hand-copied its private `INPUT_CLASSES`
/// verbatim instead. Five copies of a class list carrying a contrast fix is
/// four places for the next one to be missed - which is the argument this
/// file was created to make about the button.
export const INPUT_CLASSES =
  'border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500'

/**
 * A sideways-scrolling wrapper a keyboard can actually scroll (WCAG 2.1.1).
 *
 * ==========================================================================
 * A `div.overflow-x-auto` HOLDING ONLY A TABLE IS A SCROLLABLE REGION WITH NO
 * FOCUSABLE CHILD, so there is no way to reach its scrollbar without a mouse
 * or a trackpad: everything to the right of the fold is simply unreachable.
 * A table is exactly the content that has no links or buttons in it, which is
 * why tables are where this always happens.
 *
 * FOUND ON MILESTONE 11'S DEMO WALK, at a phone viewport, on `/portal/pay/
 * history` — a tenant's own payment record. Nine wrappers had it and five did
 * not, because `reports/operating` fixed the two it owned and its own comment
 * says why the rest stayed invisible: *the defect does not exist at a desktop
 * width where the table happens to fit*. axe only fires when the region
 * ACTUALLY overflows, so a walk at 1280px reports nothing and the same page
 * on a phone is a serious violation. Do not trust a green scan at one width.
 *
 * Three attributes and nothing else, spread beside the caller's own
 * `className`, on the pattern `pendingButtonProps` set (R-115). `role="group"`
 * rather than `region`: a landmark per table would put a dozen of them in the
 * landmark list of a page like `/leases/[id]`, which is noise where this is
 * navigation of one control.
 *
 * The label is the caller's because it is the only part that differs, and it
 * is usually the table's own `sr-only` caption — say the same thing, so the
 * region and the table it contains do not appear to be two different things.
 * ==========================================================================
 */
export function scrollableRegionProps(label: string) {
  return { tabIndex: 0, role: 'group', 'aria-label': label } as const
}
