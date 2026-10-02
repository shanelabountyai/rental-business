import type { ReactNode } from 'react'

// UX-07: the one section-panel wrapper, replacing the `<section
// aria-labelledby="x" className="flex flex-col gap-N border-t pt-4">` +
// `<h2 id="x" className="text-lg font-semibold">` shape that ~40 panel
// components each hand-rolled identically.
//
// `headingId` is required, not generated, because several callers also use
// it as an anchor target (`#ledger`, `#fees`) from elsewhere in the page —
// migrating a file must keep its existing id string.
export function Panel({
  title,
  headingId,
  gap = 'gap-3',
  trailing,
  children,
}: {
  title: ReactNode
  headingId: string
  gap?: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={headingId} className={`flex flex-col ${gap} border-t pt-4`}>
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
