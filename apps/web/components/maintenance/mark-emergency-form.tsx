'use client'

import { useActionState } from 'react'
import { FormAlerts, pendingButtonProps } from '@/components/auth-form.tsx'
import type { MaintenanceFormState } from '@/lib/maintenance/actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// R-223: the staff-side writer of EMERGENCY, on the ticket itself - the
// triage Task that also offers it can be an hour behind (triage-consumer.ts),
// and the on-call suggestion a text sends links here.
//
// ALWAYS MOUNTED, and only the form inside it is conditional. The press
// that succeeds turns the ticket into an emergency, which removes the form -
// if the whole component went with it, the confirmation would render
// nowhere (CLAUDE.md: a result region must not live inside something its
// own action can unmount).
export function MarkEmergencyForm({
  ticketId,
  isEmergency,
  action,
}: {
  ticketId: string
  isEmergency: boolean
  action: (state: MaintenanceFormState, formData: FormData) => Promise<MaintenanceFormState>
}) {
  const [state, formAction, pending] = useActionState<MaintenanceFormState, FormData>(action, {})

  return (
    <div className="flex flex-col gap-2">
      <FormAlerts state={state} />
      {!isEmergency && (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <p className="text-muted-foreground text-sm">
            If this cannot wait, marking it an emergency pages whoever is on call now, and
            everybody else with authority over the property if nobody acknowledges within 15
            minutes.
          </p>
          <button
            type="submit"
            {...pendingButtonProps(pending)}
            className={`${PRIMARY_BUTTON_CLASSES} self-start`}
          >
            Mark as emergency and page on-call
          </button>
        </form>
      )}
    </div>
  )
}
