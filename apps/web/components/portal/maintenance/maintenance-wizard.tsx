'use client'

import {
  CATEGORY_LABELS,
  CLARIFYING_PROMPTS,
  MAINTENANCE_CATEGORIES,
  type MaintenanceCategory,
  applicableTroubleshootingSteps,
} from '@rental/core/maintenance'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'
import { submitMaintenanceRequest, uploadMaintenancePhoto } from '@/lib/maintenance/actions.ts'
import { TroubleshootingIllustration } from './troubleshooting-illustration.tsx'

// The tenant maintenance request flow (MAINT-01, R-019): category → 2-3
// clarifying prompts → troubleshooting (when applicable) → photos → entry
// permission → pet warning → review and submit. "Under 2 minutes end to
// end" is why this is one linear wizard with no dead ends, not a form with
// every field visible at once - a phone screen showing everything at once
// is what makes people give up and call instead.
//
// Photo upload starts the moment a photo is picked, in the background - a
// tenant can keep moving through the wizard immediately, never waiting on
// it. What "never blocks submission on a slow link" does NOT mean is that
// Submit ignores an upload that is seconds from finishing: at Submit,
// `waitForPendingUploads` gives whatever is still in flight a short, bounded
// grace period (PHOTO_GRACE_MS) to land, then submits with whatever is ready
// regardless. On a fast connection that grace period is invisible - the
// upload is long done by the time a tenant finishes the rest of the wizard.
// On a genuinely slow one, it caps the wait at a few seconds rather than
// leaving Submit hanging on the network. Either way the photo is not lost:
// see uploadMaintenancePhoto's own comment on the recovery path.
//
// This replaced an earlier, more "elegant"-looking design where a photo's
// own promise chain attached itself to the ticket after Submit had already
// navigated away - it read well but did not actually work: a client
// component's continuation is not guaranteed to survive the page it was
// created on being torn down mid-flight, and an e2e test with a small,
// fast-uploading file still lost the attachment often enough to fail
// reliably. Waiting a bounded moment BEFORE navigating, and reading each
// upload's OWN resolved result rather than React state that might be stale,
// is what actually holds up.

const PHOTO_GRACE_MS = 3000

type Step =
  | 'category'
  | 'prompts'
  | 'troubleshooting'
  | 'photos'
  | 'entry'
  | 'pets'
  | 'review'

interface Photo {
  key: string
  file: File
  status: 'uploading' | 'done' | 'error'
  documentId?: string
}

const NEXT_BUTTON =
  'bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
const BACK_BUTTON =
  'border-input hover:bg-accent focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md border px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
const OPTION_BUTTON = (selected: boolean) =>
  `focus-visible:ring-ring flex min-h-12 w-full items-center rounded-md border px-4 py-2 text-left text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
    selected ? 'border-foreground bg-accent font-medium' : 'hover:bg-accent'
  }`

export function MaintenanceWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('category')
  const [category, setCategory] = useState<MaintenanceCategory | null>(null)
  const [promptAnswers, setPromptAnswers] = useState<Record<string, string>>({})
  const [troubleshooting, setTroubleshooting] = useState<Record<string, string>>({})
  const [photos, setPhotos] = useState<Photo[]>([])
  const [entryPermission, setEntryPermission] = useState<boolean | undefined>()
  const [petWarning, setPetWarning] = useState<boolean | undefined>()
  const [petNote, setPetNote] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  // Every upload's own promise AND its resolved result, both keyed the same
  // way as its Photo entry. Two plain refs, not React state - `results` is
  // written the instant a promise settles, synchronously with that
  // resolution, so reading it at submit time can never see a stale snapshot
  // the way reading `photos` state through a closure could.
  const uploadPromises = useRef<Map<string, Promise<unknown>>>(new Map())
  const uploadResults = useRef<Map<string, { id: string } | { error: string }>>(new Map())

  const steps = applicableTroubleshootingSteps(category ?? 'PLUMBING', promptAnswers)

  function goToPromptsOrLater() {
    setStep('prompts')
  }

  function afterPrompts() {
    setStep(category && applicableTroubleshootingSteps(category, promptAnswers).length > 0
      ? 'troubleshooting'
      : 'photos')
  }

  function handlePhotoSelect(fileList: FileList | null) {
    if (!fileList) return
    for (const file of Array.from(fileList)) {
      const key = crypto.randomUUID()
      setPhotos((prev) => [...prev, { key, file, status: 'uploading' }])
      const promise = uploadMaintenancePhoto(file)
      uploadPromises.current.set(key, promise)
      promise.then((result) => {
        uploadResults.current.set(key, result)
        setPhotos((prev) =>
          prev.map((p) =>
            p.key === key
              ? 'error' in result
                ? { ...p, status: 'error' }
                : { ...p, status: 'done', documentId: result.id }
              : p,
          ),
        )
      })
    }
  }

  function removePhoto(key: string) {
    setPhotos((prev) => prev.filter((p) => p.key !== key))
    uploadPromises.current.delete(key)
    uploadResults.current.delete(key)
  }

  /// Gives any upload still in flight up to PHOTO_GRACE_MS to finish, then
  /// returns whichever document ids are ready - see this file's header for
  /// why the wait is bounded rather than either infinite or absent.
  async function waitForPendingUploads(): Promise<string[]> {
    const promises = [...uploadPromises.current.values()]
    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((resolve) => setTimeout(resolve, PHOTO_GRACE_MS)),
      ])
    }
    // Read from uploadResults, not the promises above: every promise that
    // settled already wrote its result here synchronously (see
    // handlePhotoSelect), so this reflects exactly what is ready right now.
    const ready: string[] = []
    for (const result of uploadResults.current.values()) {
      if (!('error' in result)) ready.push(result.id)
    }
    return ready
  }

  function handleSubmit() {
    if (!category) return
    setError(undefined)

    startTransition(async () => {
      const photoDocumentIds = await waitForPendingUploads()
      const result = await submitMaintenanceRequest({
        category,
        promptAnswers,
        troubleshooting,
        entryPermission,
        petWarning,
        petNote,
        photoDocumentIds,
      })
      if ('ticketId' in result) {
        router.push(`/portal/maintenance/${result.ticketId}`)
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
          <legend className="text-lg font-semibold">What&rsquo;s the problem with?</legend>
          <div className="flex flex-col gap-2">
            {MAINTENANCE_CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                className={OPTION_BUTTON(category === value)}
                onClick={() => {
                  setCategory(value)
                  setPromptAnswers({})
                  setTroubleshooting({})
                }}
              >
                {CATEGORY_LABELS[value]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={NEXT_BUTTON}
            disabled={!category}
            onClick={goToPromptsOrLater}
          >
            Next
          </button>
        </fieldset>
      )}

      {step === 'prompts' && category && (
        <div className="flex flex-col gap-6">
          {CLARIFYING_PROMPTS[category].map((prompt) => (
            <fieldset key={prompt.id} className="flex flex-col gap-2">
              <legend className="font-medium">{prompt.question}</legend>
              {prompt.type === 'select' ? (
                <div className="flex flex-col gap-2">
                  {prompt.options?.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={OPTION_BUTTON(promptAnswers[prompt.id] === option)}
                      onClick={() =>
                        setPromptAnswers((prev) => ({ ...prev, [prompt.id]: option }))
                      }
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : (
                <textarea
                  aria-label={prompt.question}
                  value={promptAnswers[prompt.id] ?? ''}
                  onChange={(event) =>
                    setPromptAnswers((prev) => ({ ...prev, [prompt.id]: event.target.value }))
                  }
                  rows={2}
                  className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                />
              )}
            </fieldset>
          ))}
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('category')}>
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={CLARIFYING_PROMPTS[category].some((p) => !promptAnswers[p.id]?.trim())}
              onClick={afterPrompts}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'troubleshooting' && category && (
        <div className="flex flex-col gap-6">
          <p>
            A few quick things to try first — this often fixes it without
            waiting for a visit.
          </p>
          {steps.map((troubleshootingStep) => (
            <fieldset
              key={troubleshootingStep.id}
              className="flex flex-col gap-3 rounded-md border p-4"
            >
              <div className="flex gap-4">
                <TroubleshootingIllustration stepId={troubleshootingStep.id} />
                <div className="flex flex-col gap-1">
                  <legend className="font-medium">{troubleshootingStep.title}</legend>
                  <p>{troubleshootingStep.instructions}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  className={OPTION_BUTTON(troubleshooting[troubleshootingStep.id] === 'TRIED')}
                  onClick={() =>
                    setTroubleshooting((prev) => ({ ...prev, [troubleshootingStep.id]: 'TRIED' }))
                  }
                >
                  I tried this
                </button>
                <button
                  type="button"
                  className={OPTION_BUTTON(
                    troubleshooting[troubleshootingStep.id] === 'DECLINED',
                  )}
                  onClick={() =>
                    setTroubleshooting((prev) => ({
                      ...prev,
                      [troubleshootingStep.id]: 'DECLINED',
                    }))
                  }
                >
                  Skip this
                </button>
              </div>
            </fieldset>
          ))}
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('prompts')}>
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={steps.some((s) => !troubleshooting[s.id])}
              onClick={() => setStep('photos')}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'photos' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Add a photo (optional)</h2>
            <p>This helps us send the right person with the right parts.</p>
          </div>
          <label className={`${BACK_BUTTON} cursor-pointer`}>
            Choose photos
            <input
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              className="sr-only"
              onChange={(event) => {
                handlePhotoSelect(event.target.files)
                event.target.value = ''
              }}
            />
          </label>
          {photos.length > 0 && (
            <ul className="flex flex-col gap-2">
              {photos.map((photo) => (
                <li
                  key={photo.key}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <span>
                    {photo.file.name}
                    {photo.status === 'uploading' && ' · uploading…'}
                    {photo.status === 'error' && ' · could not upload'}
                  </span>
                  <button
                    type="button"
                    onClick={() => removePhoto(photo.key)}
                    className="text-muted-foreground hover:text-red-700 min-h-11 rounded-md px-2 underline underline-offset-2 dark:hover:text-red-400"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              className={BACK_BUTTON}
              onClick={() =>
                setStep(
                  category && applicableTroubleshootingSteps(category, promptAnswers).length > 0
                    ? 'troubleshooting'
                    : 'prompts',
                )
              }
            >
              Back
            </button>
            <button type="button" className={NEXT_BUTTON} onClick={() => setStep('entry')}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'entry' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-semibold">
            Can we come in if you are not home?
          </legend>
          <p>If not, we will need to schedule a time that works for you.</p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className={OPTION_BUTTON(entryPermission === true)}
              onClick={() => setEntryPermission(true)}
            >
              Yes, you can enter if I am not home
            </button>
            <button
              type="button"
              className={OPTION_BUTTON(entryPermission === false)}
              onClick={() => setEntryPermission(false)}
            >
              No, please schedule a time with me
            </button>
          </div>
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('photos')}>
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={entryPermission === undefined}
              onClick={() => setStep('pets')}
            >
              Next
            </button>
          </div>
        </fieldset>
      )}

      {step === 'pets' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-semibold">Do you have a pet at home?</legend>
          <p>Whoever comes by needs to know before they open a door.</p>
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
              onClick={() => {
                setPetWarning(false)
                setPetNote('')
              }}
            >
              No
            </button>
          </div>
          {petWarning === true && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pet-note" className="font-medium">
                Anything they should know? (optional)
              </label>
              <input
                id="pet-note"
                value={petNote}
                onChange={(event) => setPetNote(event.target.value)}
                placeholder="e.g. large dog, keeps him in the yard"
                className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              />
            </div>
          )}
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('entry')}>
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={petWarning === undefined}
              onClick={() => setStep('review')}
            >
              Review
            </button>
          </div>
        </fieldset>
      )}

      {step === 'review' && category && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Review your request</h2>
          <dl className="flex flex-col gap-2 rounded-md border p-4">
            <dt className="font-medium">Category</dt>
            <dd>{CATEGORY_LABELS[category]}</dd>
            {CLARIFYING_PROMPTS[category].map((prompt) => (
              <div key={prompt.id}>
                <dt className="font-medium">{prompt.question}</dt>
                <dd>{promptAnswers[prompt.id]}</dd>
              </div>
            ))}
            <dt className="font-medium">Entry permission</dt>
            <dd>{entryPermission ? 'Yes' : 'No, schedule a time'}</dd>
            <dt className="font-medium">Pet at home</dt>
            <dd>{petWarning ? petNote.trim() || 'Yes' : 'No'}</dd>
            <dt className="font-medium">Photos</dt>
            <dd>{photos.length === 0 ? 'None' : `${photos.length} attached`}</dd>
          </dl>
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('pets')}>
              Back
            </button>
            <button
              type="button"
              className={NEXT_BUTTON}
              disabled={isPending}
              onClick={handleSubmit}
            >
              {isPending ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
