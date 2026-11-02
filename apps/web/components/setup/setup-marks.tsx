'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { SetupFormState } from '@/lib/setup/actions.ts'
import type { SetupMark } from '@/lib/setup/checklist.ts'

// The owner's three statements (R-291a). One result region for all three,
// mounted outside the forms so a press that flips a button's label still
// announces its notice.
const MARKS: { mark: SetupMark; on: string; off: string }[] = [
  { mark: 'just_me', on: 'Mark that I run this alone', off: 'Undo: I run this alone' },
  { mark: 'templates_reviewed', on: 'Mark message templates reviewed', off: 'Undo: message templates reviewed' },
  { mark: 'shared_email', on: 'Send email from the shared domain', off: 'Undo: send email from the shared domain' },
]

export function SetupMarks({
  action,
  marks,
}: {
  action: (state: SetupFormState, formData: FormData) => Promise<SetupFormState>
  marks: string[]
}) {
  const [state, formAction] = useActionState(action, {})
  return (
    <section aria-labelledby="marks-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="marks-heading" className="text-lg font-semibold">
        Steps only you can confirm
      </h2>
      <FormAlerts state={state} />
      {MARKS.map(({ mark, on, off }) => {
        const marked = marks.includes(mark)
        return (
          <form key={mark} action={formAction}>
            <input type="hidden" name="mark" value={mark} />
            <input type="hidden" name="intent" value={marked ? 'off' : 'on'} />
            <SubmitButton label={marked ? off : on} />
          </form>
        )
      })}
    </section>
  )
}
