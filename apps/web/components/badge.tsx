import type { ReactNode } from 'react'

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

// UX-06: the one semantic status pill, replacing ~24 ad hoc
// `rounded-full bg-X-100 ... text-X-900` spans that each hardcoded their own
// Tailwind palette shade. `neutral` matches the plain `bg-secondary` pill
// style already used for things like work order status.
const TONE_CLASSES: Record<BadgeTone, string> = {
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
  neutral: 'bg-secondary text-secondary-foreground',
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>{children}</span>
  )
}
