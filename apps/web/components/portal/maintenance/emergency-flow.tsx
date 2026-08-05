'use client'

import {
  EMERGENCY_CATEGORIES,
  EMERGENCY_DEFINITIONS,
  type EmergencyCategory,
} from '@rental/core/maintenance'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { submitEmergencyRequest } from '@/lib/maintenance/actions.ts'

// The emergency intake path (MAINT-01, PROP-03, R-020).
//
// Three screens, in this order and no other: what is happening → what to do
// right now (plus the shutoff) → the two questions whoever responds needs
// answered, then send.
//
// THE SAFETY SCREEN IS SHOWN BEFORE ANYTHING IS SUBMITTED AND CANNOT BE
// SKIPPED. That ordering is the whole point of this item: a tenant who can
// smell gas should read "leave now, then call 911" before they read anything
// else, and certainly before they spend thirty seconds answering questions
// for us. The submission exists to wake somebody up; the instructions exist
// to keep the tenant alive in the meantime, and they come first.
//
// No troubleshooting script runs here at all - not skipped conditionally,
// simply absent from this flow. Asking somebody with sewage backing up
// whether they have tried resetting a breaker is worse than useless.

const DANGER_BUTTON =
  'focus-visible:ring-ring flex min-h-14 w-full items-center rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 text-left text-base font-medium text-red-950 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:bg-red-950 dark:text-red-50'
const NEXT_BUTTON =
  'bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
const BACK_BUTTON =
  'border-input hover:bg-accent focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md border px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
const OPTION_BUTTON = (selected: boolean) =>
  `focus-visible:ring-ring flex min-h-12 w-full items-center rounded-md border px-4 py-2 text-left text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
    selected ? 'border-foreground bg-accent font-medium' : 'hover:bg-accent'
  }`

export interface ShutoffInfo {
  type: string
  description: string | null
  photoDocumentId: string | null
}

const SHUTOFF_WORDS: Record<string, string> = {
  WATER_MAIN: 'Your water shutoff',
  BREAKER_PANEL: 'Your breaker panel',
  GAS: 'Your gas shutoff',
  OTHER: 'Your shutoff',
}

export function EmergencyFlow({
  shutoffs,
}: {
  /// Pre-resolved on the server, keyed by emergency category, so the safety
  /// screen renders instantly with no round trip. An emergency screen that
  /// spins while it fetches is an emergency screen that failed.
  shutoffs: Partial<Record<EmergencyCategory, ShutoffInfo>>
}) {
  const router = useRouter()
  const [step, setStep] = useState<'category' | 'safety' | 'details'>('category')
  const [category, setCategory] = useState<EmergencyCategory | null>(null)
  const [detail, setDetail] = useState('')
  const [petWarning, setPetWarning] = useState<boolean | undefined>()
  const [entryPermission, setEntryPermission] = useState<boolean | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  const definition = category ? EMERGENCY_DEFINITIONS[category] : null
  const shutoff = category ? shutoffs[category] : undefined

  function handleSubmit() {
    if (!category) return
    setError(undefined)
    startTransition(async () => {
      const result = await submitEmergencyRequest({
        category,
        detail,
        petWarning,
        entryPermission,
      })
      if ('ticketId' in result) {
        router.push(`/portal/maintenance/${result.ticketId}?emergency=1`)
        return
      }
      if (result.error) setError(result.error)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      )}

      {step === 'category' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-semibold">
            What is happening right now?
          </legend>
          <div className="flex flex-col gap-2">
            {EMERGENCY_CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                className={DANGER_BUTTON}
                onClick={() => {
                  setCategory(value)
                  // Straight to the safety screen on ONE tap. No confirm
                  // step, no "Next" - the instructions are the thing they
                  // came for, and every extra tap is a second they do not
                  // have.
                  setStep('safety')
                }}
              >
                {EMERGENCY_DEFINITIONS[value].label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {step === 'safety' && definition && (
        <div className="flex flex-col gap-6">
          <section
            aria-labelledby="do-now"
            className="flex flex-col gap-3 rounded-md border-2 border-red-600 bg-red-50 p-4 dark:bg-red-950"
          >
            <h2 id="do-now" className="text-lg font-semibold text-red-950 dark:text-red-50">
              Do this now
            </h2>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-red-950 dark:text-red-50">
              {definition.selfProtection.map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ol>
          </section>

          {definition.shutoffType && (
            <section aria-labelledby="shutoff" className="flex flex-col gap-2">
              <h2 id="shutoff" className="text-lg font-semibold">
                {SHUTOFF_WORDS[definition.shutoffType] ?? 'Your shutoff'}
              </h2>
              {shutoff?.description ? (
                <p>{shutoff.description}</p>
              ) : (
                // Honest rather than empty: a tenant who reads "we do not
                // have this on file" knows to stop looking and call, which
                // is more useful than a blank space they keep staring at.
                <p>
                  We do not have this recorded for your home yet. If you cannot
                  find it safely, do not keep looking — call us.
                </p>
              )}
              {shutoff?.photoDocumentId && (
                <a
                  href={`/api/documents/${shutoff.photoDocumentId}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-12 w-fit items-center rounded-md border px-4 py-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  See the photo
                </a>
              )}
            </section>
          )}

          <p>
            When you are safe, send this to us and we will wake someone up.
            You can also call or text the number on your lease.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              className={BACK_BUTTON}
              onClick={() => setStep('category')}
            >
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              onClick={() => setStep('details')}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'details' && definition && (
        <div className="flex flex-col gap-6">
          <h2 className="text-lg font-semibold">{definition.label}</h2>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">
              Can we come in if you are not home?
            </legend>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className={OPTION_BUTTON(entryPermission === true)}
                onClick={() => setEntryPermission(true)}
              >
                Yes
              </button>
              <button
                type="button"
                className={OPTION_BUTTON(entryPermission === false)}
                onClick={() => setEntryPermission(false)}
              >
                No
              </button>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">Is there a pet at home?</legend>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className={OPTION_BUTTON(petWarning === true)}
                onClick={() => setPetWarning(true)}
              >
                Yes
              </button>
              <button
                type="button"
                className={OPTION_BUTTON(petWarning === false)}
                onClick={() => setPetWarning(false)}
              >
                No
              </button>
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="emergency-detail" className="font-medium">
              Anything else we should know? (optional)
            </label>
            <textarea
              id="emergency-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              rows={3}
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              className={BACK_BUTTON}
              onClick={() => setStep('safety')}
            >
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={
                isPending || entryPermission === undefined || petWarning === undefined
              }
              onClick={handleSubmit}
            >
              {isPending ? 'Sending…' : 'Send now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
