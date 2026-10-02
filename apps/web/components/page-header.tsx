import { forwardRef, type ReactNode } from 'react'

// UX-07: the one page-title wrapper. `focusable` is for the three
// `error.tsx` boundaries (R-099), which move focus to the heading on mount
// so a thrown page doesn't leave a screen reader announcing nothing — that
// needs a real DOM ref, so this is `forwardRef` rather than a plain
// function component. It also fixes `(admin)/error.tsx`'s `text-xl`, the one
// page heading that didn't match every other page's `text-2xl`.
export const PageHeader = forwardRef<
  HTMLHeadingElement,
  {
    title: ReactNode
    children?: ReactNode
    focusable?: boolean
  }
>(function PageHeader({ title, children, focusable = false }, ref) {
  return (
    <div className="flex flex-col gap-2">
      <h1
        ref={ref}
        tabIndex={focusable ? -1 : undefined}
        className="text-2xl font-semibold tracking-tight"
      >
        {title}
      </h1>
      {children}
    </div>
  )
})
