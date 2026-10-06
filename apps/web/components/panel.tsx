import type { ReactNode } from 'react'

// UX-07: the one section-panel wrapper, replacing the `<section
// aria-labelledby="x" className="flex flex-col gap-N border-t pt-4">` +
// `<h2 id="x" className="text-lg font-semibold">` shape that ~40 panel
// components each hand-rolled identically.
//
// `headingId` is required, not generated, because several callers also use
// it as an anchor target (`#ledger`, `#fees`) from elsewhere in the page —
// migrating a file must keep its existing id string.
//
// `variant="boxed"` is the `rounded-md border p-4` card the detail pages
// hand-rolled around the same heading (D-284's follow-up). Only sections that
// already had this exact shape use it; forms, fieldsets, list items and
// anything with conditional styling stay bespoke.
export function Panel({
  title,
  headingId,
  gap = 'gap-3',
  variant = 'divided',
  trailing,
  children,
}: {
  title: ReactNode
  headingId: string
  gap?: string
  variant?: 'divided' | 'boxed'
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={headingId} className={`flex flex-col ${gap} ${variant === 'boxed' ? 'rounded-md border p-4' : 'border-t pt-4'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  )
}
