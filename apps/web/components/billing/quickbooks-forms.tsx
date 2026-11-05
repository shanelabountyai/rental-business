'use client'

import { FormAlerts, SubmitButton, pendingButtonProps } from '@/components/auth-form.tsx'
import { INPUT_CLASSES, PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { useOpening } from '@/components/billing/connect-stripe-form.tsx'
import type { StripeFormState } from '@/lib/integrations/stripe-actions.ts'
import type { FormState } from '@/components/auth-form.tsx'
import { useActionState } from 'react'

type Action = (state: StripeFormState, formData: FormData) => Promise<StripeFormState>

/// R-280: connect (or reconnect) one entity's QuickBooks file. Basis and
/// property field are asked only on a first connect (D-393, D-395); a
/// reconnect keeps them.
export function ConnectQuickBooksForm({
  action,
  entities,
}: {
  action: Action
  entities: { id: string; name: string; firstConnect: boolean }[]
}) {
  const { state, formAction } = useOpening(action)
  const anyFirst = entities.some((entity) => entity.firstConnect)
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="qb-entity" className="text-sm font-medium">
          Entity
        </label>
        <select id="qb-entity" name="legalEntityId" required className={`${INPUT_CLASSES} w-full`}>
          {entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.name}
              {entity.firstConnect ? '' : ' (reconnect)'}
            </option>
          ))}
        </select>
      </div>
      {anyFirst && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Accounting basis</legend>
            <p className="text-sm text-muted-foreground">
              Ask your CPA. It decides which month income lands in, so there is no default, and it is kept on a reconnect.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="basis" value="CASH" className="size-5" /> Cash
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="basis" value="ACCRUAL" className="size-5" /> Accrual
            </label>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Track each property as a QuickBooks</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="propertyField" value="CLASS" defaultChecked className="size-5" /> Class
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="propertyField" value="LOCATION" className="size-5" /> Location
            </label>
          </fieldset>
        </>
      )}
      <div>
        <SubmitButton label="Connect QuickBooks" />
      </div>
    </form>
  )
}

/// One entity's disconnect. Named for the entity: there is one per row.
export function DisconnectQuickBooksForm({ action, entityName }: { action: Action; entityName: string }) {
  const { state, formAction } = useOpening(action)
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <div>
        <SubmitButton
          label={
            <>
              Disconnect<span className="sr-only"> {entityName}</span>
            </>
          }
        />
      </div>
    </form>
  )
}

/// The simulated consent page (D-27): which company file, and allow or cancel.
export function SimulatedQuickBooksConsentForm({ action, suggestedRealm }: { action: Action; suggestedRealm: string }) {
  const { state, formAction, pending } = useOpening(action)
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="qb-realm" className="text-sm font-medium">
          Company id
        </label>
        <input id="qb-realm" name="realmId" defaultValue={suggestedRealm} className={`${INPUT_CLASSES} w-full font-mono`} />
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" name="answer" value="approve" {...pendingButtonProps(pending)} className={`${PRIMARY_BUTTON_CLASSES} min-h-11 px-4`}>
          Allow access
        </button>
        <button type="submit" name="answer" value="cancel" {...pendingButtonProps(pending)} className={`${PRIMARY_BUTTON_CLASSES} min-h-11 px-4`}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type PlainAction = (state: FormState, formData: FormData) => Promise<FormState>

/// R-283 (Q10): run the sync for one entity now rather than tonight.
export function SyncQuickBooksNowForm({ action }: { action: PlainAction }) {
  const [state, formAction] = useActionState(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <div>
        <SubmitButton label="Sync now" />
      </div>
    </form>
  )
}

/// R-283 (Q10): send one day's journals through again. Ones QuickBooks still
/// holds are left alone; ones deleted there are posted again.
export function ReplayQuickBooksDateForm({ action, max }: { action: PlainAction; max: string }) {
  const [state, formAction] = useActionState(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="qb-replay-day" className="text-sm font-medium">
          Day to replay
        </label>
        <input id="qb-replay-day" type="date" name="day" required max={max} className={`${INPUT_CLASSES} w-full sm:w-auto`} />
      </div>
      <div>
        <SubmitButton label="Replay day" />
      </div>
    </form>
  )
}
