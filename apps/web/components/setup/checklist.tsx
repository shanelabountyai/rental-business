import { type Checklist, SETUP_STEPS, STEP_LABELS, type SetupStep } from '@/lib/setup/checklist.ts'

// The ten steps (PRD 10 §5) as an ordered list, shared by the org's
// /settings/setup and the console. Done is said in words, not only by a mark,
// so it reads the same to a screen reader. `reasons` is the org side's: the
// console has only the booleans (PRD 11 §4.4).
export function ChecklistSteps({
  checklist,
  reasons,
  links,
}: {
  checklist: Checklist
  reasons?: Partial<Record<SetupStep, string | null>>
  links?: Partial<Record<SetupStep, { href: string; label: string }>>
}) {
  return (
    <ol className="flex flex-col gap-3 text-sm">
      {SETUP_STEPS.map((step, i) => {
        const done = checklist[step]
        const reason = reasons?.[step]
        const link = links?.[step]
        return (
          <li key={step} className="flex flex-col gap-1 rounded-md border p-3 break-words">
            <span className="font-medium">
              {i + 1}. {STEP_LABELS[step].label}:{' '}
              <span className={done ? 'text-success' : 'text-muted-foreground'}>{done ? 'done' : 'not done'}</span>
            </span>
            <span className="text-muted-foreground">Who: {STEP_LABELS[step].owner}</span>
            {reason && <span>{reason}</span>}
            {!done && link && (
              <a href={link.href} className="underline underline-offset-4">
                {link.label}
              </a>
            )}
          </li>
        )
      })}
    </ol>
  )
}
