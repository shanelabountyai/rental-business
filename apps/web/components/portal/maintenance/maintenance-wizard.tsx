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
import { LiveRegion } from '@/components/auth-form.tsx'
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
/// The visual shape of a choice. Applied to a `<label>` now rather than a
/// `<button>` - see `Choice` below for why - so the focus ring has to come
/// from `focus-within`, because the thing actually receiving focus is the
/// radio inside it.
const OPTION_BUTTON = (selected: boolean) =>
  `focus-within:ring-ring relative flex min-h-12 w-full cursor-pointer items-center rounded-md border px-4 py-2 text-left text-base focus-within:ring-2 focus-within:ring-offset-2 ${
    selected ? 'border-foreground bg-accent font-medium' : 'hover:bg-accent'
  }`

/**
 * One option in a group, as a REAL radio (R-101b).
 *
 * ==========================================================================
 * These were `<button type="button">` with an onClick, styled to look
 * selected. Visually identical, and wrong in four ways that only a keyboard
 * or screen-reader user ever meets:
 *
 *   - announced as "button", never as "radio, 3 of 7", so there is no way to
 *     know how many choices exist or which is current;
 *   - the selected one announced nothing at all - the styling carried the
 *     entire meaning, and styling is not exposed to assistive technology;
 *   - no arrow-key navigation, which is how radio groups are operated;
 *   - every option a separate tab stop, so reaching the Next button on the
 *     category step took seven presses.
 *
 * A visually-hidden `<input type="radio">` inside the styled label buys all
 * four back from the platform, with no roving-tabindex code to maintain. The
 * `<fieldset>`/`<legend>` around each group was already correct and is what
 * makes the radio's group name announced.
 * ==========================================================================
 */
function Choice({
  name,
  value,
  checked,
  onSelect,
  children,
}: {
  name: string
  value: string
  checked: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <label className={OPTION_BUTTON(checked)}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        // Invisible but COVERING THE WHOLE LABEL, rather than `sr-only`.
        //
        // Hidden from sight, never from the accessibility tree - `hidden` or
        // `display:none` would remove the radio entirely and give back the
        // problem this exists to fix. But `sr-only` clips it to one pixel, so
        // every real click lands on the label instead of the control: the
        // browser forwards that, and automation reports the label
        // "intercepts pointer events". Stretching the transparent input over
        // the label means the thing being clicked IS the radio.
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
      {children}
    </label>
  )
}

/**
 * A Next button that stays reachable when it cannot yet be used (R-101b).
 *
 * `disabled` removes a control from the tab order, so a keyboard user tabs
 * straight past the only thing standing between them and submitting, with
 * nothing said about why. `aria-disabled` keeps it focusable and announced as
 * unavailable, and the reason is tied to it with `aria-describedby` so it is
 * read out rather than merely displayed.
 *
 * The reason sits in a live region (R-101), so it is also announced the
 * moment it changes.
 */
function NextButton({
  onClick,
  blockedBy,
  label = 'Next',
}: {
  onClick: () => void
  /// Why it cannot be pressed yet, or null when it can.
  blockedBy: string | null
  label?: string
}) {
  const id = `next-blocked-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={`${NEXT_BUTTON} ${blockedBy ? 'opacity-50' : ''}`}
        aria-disabled={blockedBy ? true : undefined}
        aria-describedby={blockedBy ? id : undefined}
        onClick={() => {
          if (!blockedBy) onClick()
        }}
      >
        {label}
      </button>
      <div role="status" className="contents">
        {blockedBy && (
          <p id={id} className="text-muted-foreground text-sm">
            {blockedBy}
          </p>
        )}
      </div>
    </div>
  )
}

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
      <LiveRegion assertive>
        {error && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">{error}</p>}
      </LiveRegion>

      {step === 'category' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-semibold">What&rsquo;s the problem with?</legend>
          <div className="flex flex-col gap-2">
            {MAINTENANCE_CATEGORIES.map((value) => (
              <Choice
                key={value}
                name="category"
                value={value}
                checked={category === value}
                onSelect={() => {
                  setCategory(value)
                  setPromptAnswers({})
                  setTroubleshooting({})
                }}
              >
                {CATEGORY_LABELS[value]}
              </Choice>
            ))}
          </div>
          <NextButton
            onClick={goToPromptsOrLater}
            blockedBy={category ? null : 'Choose what the problem is to continue.'}
          />
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
                    <Choice
                      key={option}
                      name={`prompt-${prompt.id}`}
                      value={option}
                      checked={promptAnswers[prompt.id] === option}
                      onSelect={() =>
                        setPromptAnswers((prev) => ({ ...prev, [prompt.id]: option }))
                      }
                    >
                      {option}
                    </Choice>
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
            <NextButton
              onClick={afterPrompts}
              blockedBy={
                CLARIFYING_PROMPTS[category].some((p) => !promptAnswers[p.id]?.trim())
                  ? 'Answer every question above to continue.'
                  : null
              }
            />
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
                <Choice
                  name={`troubleshooting-${troubleshootingStep.id}`}
                  value="TRIED"
                  checked={troubleshooting[troubleshootingStep.id] === 'TRIED'}
                  onSelect={() =>
                    setTroubleshooting((prev) => ({ ...prev, [troubleshootingStep.id]: 'TRIED' }))
                  }
                >
                  I tried this
                </Choice>
                <Choice
                  name={`troubleshooting-${troubleshootingStep.id}`}
                  value="DECLINED"
                  checked={troubleshooting[troubleshootingStep.id] === 'DECLINED'}
                  onSelect={() =>
                    setTroubleshooting((prev) => ({
                      ...prev,
                      [troubleshootingStep.id]: 'DECLINED',
                    }))
                  }
                >
                  Skip this
                </Choice>
              </div>
            </fieldset>
          ))}
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('prompts')}>
              Back
            </button>
            <NextButton
              onClick={() => setStep('photos')}
              blockedBy={
                steps.some((s) => !troubleshooting[s.id])
                  ? 'Tell us whether you tried each step, or skip it, to continue.'
                  : null
              }
            />
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
            <Choice
              name="entry-permission"
              value="yes"
              checked={entryPermission === true}
              onSelect={() => setEntryPermission(true)}
            >
              Yes, you can enter if I am not home
            </Choice>
            <Choice
              name="entry-permission"
              value="no"
              checked={entryPermission === false}
              onSelect={() => setEntryPermission(false)}
            >
              No, please schedule a time with me
            </Choice>
          </div>
          <div className="flex gap-3">
            <button type="button" className={BACK_BUTTON} onClick={() => setStep('photos')}>
              Back
            </button>
            <NextButton
              onClick={() => setStep('pets')}
              blockedBy={
                entryPermission === undefined ? 'Choose yes or no to continue.' : null
              }
            />
          </div>
        </fieldset>
      )}

      {step === 'pets' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-semibold">Do you have a pet at home?</legend>
          <p>Whoever comes by needs to know before they open a door.</p>
          <div className="flex flex-col gap-2">
            <Choice
              name="pet-warning"
              value="yes"
              checked={petWarning === true}
              onSelect={() => setPetWarning(true)}
            >
              Yes
            </Choice>
            <Choice
              name="pet-warning"
              value="no"
              checked={petWarning === false}
              onSelect={() => {
                setPetWarning(false)
                setPetNote('')
              }}
            >
              No
            </Choice>
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
            <NextButton
              label="Review"
              onClick={() => setStep('review')}
              blockedBy={petWarning === undefined ? 'Choose yes or no to continue.' : null}
            />
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
