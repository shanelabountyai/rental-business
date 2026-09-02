'use client'

import {
  CATEGORY_LABELS,
  CLARIFYING_PROMPTS,
  MAINTENANCE_CATEGORIES,
  type MaintenanceCategory,
  applicableTroubleshootingSteps,
  isMaintenanceCategory,
} from '@rental/core/maintenance'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import {
  submitMaintenanceRequest,
  submitMaintenanceRequestForm,
  uploadMaintenancePhoto,
} from '@/lib/maintenance/actions.ts'
import { TroubleshootingIllustration } from './troubleshooting-illustration.tsx'

// The tenant maintenance request flow (MAINT-01, R-019): category → 2-3
// clarifying prompts → troubleshooting (when applicable) → photos → entry
// permission → pet warning → review and submit. "Under 2 minutes end to
// end" is why this is one linear wizard with no dead ends, not a form with
// every field visible at once - a phone screen showing everything at once
// is what makes people give up and call instead.
//
// ==========================================================================
// EVERY STEP IS A REAL FORM SUBMISSION, AND THE ANSWERS LIVE IN THE URL
// (R-111, audit angle ④).
//
// This wizard was seven `onClick` handlers over `useState`. Before hydration
// - a cheap phone on a weak connection, which is most of this product's
// tenants - the radios rendered and were tappable and "Next" did nothing at
// all, with no message. The tenant taps, taps again, and gives up. Next
// door, the EMERGENCY path was rewritten to be URL-driven for exactly this
// reason (R-098) and carries a comment saying so; the ordinary path - the
// one every non-emergency tenant uses, and the one with the volume - was
// left behind. Hardening is drawn to the scary path.
//
// So: each step is a `<form method="get">` whose controls carry real `name`s,
// Next and Back are `<button type="submit" name="step">`, and everything
// answered so far rides along as hidden inputs. With no JavaScript at all,
// pressing Next is a navigation and the next step arrives as HTML. With
// JavaScript, `onClick`/`onSubmit` preventDefault and the same transition
// happens locally, instantly, exactly as before - a handler that only exists
// after hydration is precisely the test we need, so no hydration flag decides
// where a press goes. One exists for a narrower job: a Next button may only
// call itself unavailable once it really is (see NextButton).
//
// `reachableStep` is what makes the URL safe to trust: it clamps whatever
// arrives to the furthest step the answers actually support, so a hand-typed
// link, a stale bookmark, or a pre-hydration press of a Next that was not yet
// allowed all land on the first step still missing something - where that
// step's own "why you cannot continue yet" text is already on screen, because
// it is derived from the same seeded state. Deep-linking, the back button and
// a screen reader announcing the new page all come free with it.
//
// The ONE thing that still needs JavaScript is choosing photos, because a
// file cannot be carried in a query string. Photos are optional, the step
// says so in a `<noscript>`, and `attachMaintenancePhoto` on the ticket page
// is the after-the-fact path. Nothing else in the flow depends on the client.
//
// KNOWN CORNER, deliberately not coded around: the radios stay controlled, so
// a tap made in the window between first paint and hydration can be reset
// when React takes over. Pressing Next in that same window is a navigation
// and always works, and after hydration everything behaves as it always did -
// the only casualty is a tap straddling the boundary, which costs one repeat
// tap. Seeding React state from the DOM on mount would close it and is
// several times the code; the defect being fixed here is a Next button that
// did nothing at all, for ever, with no message.
// ==========================================================================
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

const NEVER_CHANGES = () => () => {}

/// The steps in order. Index order is what `reachableStep` clamps against,
/// so it is the definition of "further on in the flow", not just a list.
const ORDER = [
  'category',
  'prompts',
  'troubleshooting',
  'photos',
  'entry',
  'pets',
  'review',
] as const

type Step = (typeof ORDER)[number]

interface Photo {
  key: string
  file: File
  status: 'uploading' | 'done' | 'error'
  documentId?: string
}

/// What arrives in the query string. The wizard's whole answer set, minus
/// photos - see the header comment for why those are the one exception.
export type WizardParams = Record<string, string | string[] | undefined>

const NEXT_BUTTON =
  'bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
const BACK_BUTTON =
  'border-input hover:bg-secondary focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md border px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'
/// The visual shape of a choice. Applied to a `<label>` rather than a
/// `<button>` - see `Choice` below for why - so both the focus ring and the
/// selected styling come from the RADIO INSIDE IT (`focus-within`,
/// `has-[:checked]`) rather than from React state. Two reasons, and the
/// second is R-111's: the thing actually receiving focus is the input, and a
/// tap made before this page has hydrated has to look like it landed.
const OPTION_BUTTON =
  'focus-within:ring-ring has-[:checked]:border-foreground has-[:checked]:bg-secondary relative flex min-h-12 w-full cursor-pointer items-center rounded-md border px-4 py-2 text-left text-base focus-within:ring-2 focus-within:ring-offset-2 has-[:checked]:font-medium hover:bg-secondary'

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/// Pulls `p_where=Toilet` style answers out of the query string into the
/// shape the rest of the wizard (and `validateMaintenanceRequest`) uses.
function prefixed(params: WizardParams, prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(params)) {
    const value = one(raw)
    if (key.startsWith(prefix) && value) out[key.slice(prefix.length)] = value
  }
  return out
}

interface Answers {
  category: MaintenanceCategory | null
  promptAnswers: Record<string, string>
  troubleshooting: Record<string, string>
  entryPermission: boolean | undefined
  petWarning: boolean | undefined
  petNote: string
}

/// Every answer as form fields, in the exact names the query string and
/// `submitMaintenanceRequestForm` both use. One list feeds the hidden inputs
/// that carry state through a no-JS navigation, the review step's POST, and
/// the review step's Back link.
function answerFields(answers: Answers): [string, string][] {
  const fields: [string, string][] = []
  if (answers.category) fields.push(['category', answers.category])
  for (const [id, value] of Object.entries(answers.promptAnswers)) {
    if (value) fields.push([`p_${id}`, value])
  }
  for (const [id, value] of Object.entries(answers.troubleshooting)) {
    if (value) fields.push([`t_${id}`, value])
  }
  if (answers.entryPermission !== undefined) {
    fields.push(['entry', answers.entryPermission ? 'yes' : 'no'])
  }
  if (answers.petWarning !== undefined) {
    fields.push(['pet', answers.petWarning ? 'yes' : 'no'])
  }
  if (answers.petNote.trim()) fields.push(['petNote', answers.petNote])
  return fields
}

/**
 * The furthest step these answers actually support.
 *
 * Both the guard on a URL somebody typed and the flow's own branching: the
 * troubleshooting step is skipped entirely when no step applies to the
 * answers given, which is why the prompts step's Next can simply aim at it.
 * The skip is FORWARD-ONLY - a Back aimed at a step that does not apply would
 * be clamped straight back to where it started, so the photos step names its
 * own target instead.
 */
function reachableStep(requested: Step, answers: Answers): Step {
  const { category, promptAnswers, troubleshooting } = answers
  if (!category) return 'category'

  const steps = applicableTroubleshootingSteps(category, promptAnswers)
  let furthest = ORDER.indexOf('review')
  if (CLARIFYING_PROMPTS[category].some((p) => !promptAnswers[p.id]?.trim())) {
    furthest = ORDER.indexOf('prompts')
  } else if (steps.length > 0 && steps.some((s) => !troubleshooting[s.id])) {
    furthest = ORDER.indexOf('troubleshooting')
  } else if (answers.entryPermission === undefined) {
    // Photos are optional, so the first step that can still block is entry.
    furthest = ORDER.indexOf('entry')
  } else if (answers.petWarning === undefined) {
    furthest = ORDER.indexOf('pets')
  }

  let index = Math.min(ORDER.indexOf(requested), furthest)
  if (ORDER[index] === 'troubleshooting' && steps.length === 0) {
    index = ORDER.indexOf('photos')
  }
  return ORDER[index]
}

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
 * four back from the platform, with no roving-tabindex code to maintain.
 *
 * The radio's `name` is also the query-string key its answer travels under
 * (R-111), so a no-JavaScript submission of this step needs no hidden copy of
 * the control's own value - the platform sends it.
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
    <label className={OPTION_BUTTON}>
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

/// The answers this step does not itself render as controls, as hidden
/// inputs, so a no-JS navigation does not lose them. `owns` is a predicate
/// over field names rather than a list because a step owns a whole family of
/// them (`p_*`, `t_*`).
function CarriedAnswers({
  answers,
  owns,
}: {
  answers: Answers
  owns: (name: string) => boolean
}) {
  return (
    <>
      {answerFields(answers)
        .filter(([name]) => !owns(name))
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
    </>
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
 *
 * It is a real submit button (R-112). Pressed before hydration it navigates,
 * and `reachableStep` sends a tenant who could not yet continue straight back
 * to this step - where this same text is already rendered, because it is
 * derived from the answers in the URL.
 *
 * WHICH IS WHY `aria-disabled` WAITS FOR HYDRATION and the guidance does not.
 * Before hydration this button works: pressing it submits the step. Saying
 * "unavailable" then would be a lie about a control that functions, and
 * assistive technology and automation both take that claim seriously - it is
 * what stops a press. The reason still renders, because "choose one to
 * continue" is true either way; only the unavailable STATE waits until it is
 * accurate, which is the one place this file needs to know it has hydrated.
 */
function NextButton({
  target,
  onNavigate,
  blockedBy,
  hydrated,
  label = 'Next',
}: {
  target: Step
  onNavigate: (step: Step) => void
  /// Why it cannot be pressed yet, or null when it can.
  blockedBy: string | null
  hydrated: boolean
  label?: string
}) {
  const id = `next-blocked-${label.replace(/\W+/g, '-').toLowerCase()}`
  const unavailable = hydrated && blockedBy !== null
  return (
    <div className="flex flex-col gap-2">
      <button
        type="submit"
        name="step"
        value={target}
        className={`${NEXT_BUTTON} ${unavailable ? 'opacity-50' : ''}`}
        aria-disabled={unavailable ? true : undefined}
        aria-describedby={blockedBy ? id : undefined}
        onClick={(event) => {
          event.preventDefault()
          if (!blockedBy) onNavigate(target)
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

function BackButton({
  target,
  onNavigate,
}: {
  target: Step
  onNavigate: (step: Step) => void
}) {
  return (
    <button
      type="submit"
      name="step"
      value={target}
      className={BACK_BUTTON}
      onClick={(event) => {
        event.preventDefault()
        onNavigate(target)
      }}
    >
      Back
    </button>
  )
}

export function MaintenanceWizard({ initial = {} }: { initial?: WizardParams }) {
  const router = useRouter()

  const seededCategory = one(initial.category)
  const [category, setCategory] = useState<MaintenanceCategory | null>(
    seededCategory && isMaintenanceCategory(seededCategory) ? seededCategory : null,
  )
  const [promptAnswers, setPromptAnswers] = useState<Record<string, string>>(() =>
    prefixed(initial, 'p_'),
  )
  const [troubleshooting, setTroubleshooting] = useState<Record<string, string>>(() =>
    prefixed(initial, 't_'),
  )
  const [photos, setPhotos] = useState<Photo[]>([])
  const [entryPermission, setEntryPermission] = useState<boolean | undefined>(
    one(initial.entry) === undefined ? undefined : one(initial.entry) === 'yes',
  )
  const [petWarning, setPetWarning] = useState<boolean | undefined>(
    one(initial.pet) === undefined ? undefined : one(initial.pet) === 'yes',
  )
  const [petNote, setPetNote] = useState(one(initial.petNote) ?? '')
  const [error, setError] = useState<string | undefined>(
    // The no-JS submit path cannot hand a message back any other way, and it
    // sends a flag rather than the text: a URL that renders arbitrary prose
    // inside this product's own chrome is a phishing link somebody can post.
    one(initial.err)
      ? 'We could not send that request. Check your answers below and try again.'
      : undefined,
  )
  const [isPending, startTransition] = useTransition()

  const answers: Answers = {
    category,
    promptAnswers,
    troubleshooting,
    entryPermission,
    petWarning,
    petNote,
  }

  const requested = one(initial.step)
  const [step, setStepRaw] = useState<Step>(() =>
    reachableStep(
      ORDER.includes(requested as Step) ? (requested as Step) : 'category',
      answers,
    ),
  )

  /// Every step change goes through here, so the skip-troubleshooting-when-
  /// nothing-applies rule lives in exactly one place and is the same rule the
  /// URL is clamped by.
  function goTo(target: Step) {
    setStepRaw(reachableStep(target, answers))
  }

  // Moving to a new step unmounts the button that had focus, so without this
  // a keyboard user is dropped at `<body>` and a screen reader says nothing
  // about the step that just arrived (audit, tenant portal ⑵). Focusing the
  // new step's heading announces the whole new context rather than one line
  // of it - the same argument `useFocusWhen` makes, but this fires on every
  // step, not once, so it cannot use that hook.
  //
  // NOT on first render: arriving here by navigation (including the no-JS
  // path, where the browser has already put focus at the top of a fresh
  // document) must not yank focus away from somebody who just landed.
  // The one thing this file knows about hydration, and only because a
  // control's DISABLED STATE is a claim that has to be true - see NextButton.
  // `useSyncExternalStore` with a server snapshot of `false` is the version of
  // this that does not set state inside an effect (which lints as a cascading
  // render, correctly); nothing ever changes, so the subscribe is a no-op.
  const hydrated = useSyncExternalStore(NEVER_CHANGES, () => true, () => false)

  const headingRef = useRef<HTMLElement | null>(null)
  const settled = useRef(false)
  useEffect(() => {
    if (!settled.current) {
      settled.current = true
      return
    }
    headingRef.current?.focus()
  }, [step])
  const setHeading = (element: HTMLElement | null) => {
    headingRef.current = element
  }

  // Every upload's own promise AND its resolved result, both keyed the same
  // way as its Photo entry. Two plain refs, not React state - `results` is
  // written the instant a promise settles, synchronously with that
  // resolution, so reading it at submit time can never see a stale snapshot
  // the way reading `photos` state through a closure could.
  const uploadPromises = useRef<Map<string, Promise<unknown>>>(new Map())
  const uploadResults = useRef<Map<string, { id: string } | { error: string }>>(new Map())

  const steps = applicableTroubleshootingSteps(category ?? 'PLUMBING', promptAnswers)

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

  const uploading = photos.filter((photo) => photo.status === 'uploading').length
  const failed = photos.filter((photo) => photo.status === 'error').length
  const uploaded = photos.filter((photo) => photo.status === 'done').length
  // A failed photo on a maintenance request is evidence lost, and it was lost
  // silently: the per-row text is the only signal and nothing announces it.
  const photoStatus =
    failed > 0
      ? `${failed} photo${failed === 1 ? '' : 's'} could not be uploaded. Remove and try again, or add it from the request after you send it.`
      : uploading > 0
        ? `Uploading ${uploading} photo${uploading === 1 ? '' : 's'}…`
        : uploaded > 0
          ? `${uploaded} photo${uploaded === 1 ? '' : 's'} added.`
          : null

  return (
    <div className="flex flex-col gap-6">
      <LiveRegion assertive>
        {error && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900">{error}</p>}
      </LiveRegion>

      {step === 'category' && (
        <form method="get" className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
              What&rsquo;s the problem with?
            </legend>
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
              hydrated={hydrated}
              target="prompts"
              onNavigate={goTo}
              blockedBy={category ? null : 'Choose what the problem is to continue.'}
            />
          </fieldset>
          {/* Answers to a previous category's questions do not survive
              choosing a different one - the same reset the click handler
              above does. */}
          <CarriedAnswers
            answers={answers}
            owns={(name) =>
              name === 'category' || name.startsWith('p_') || name.startsWith('t_')
            }
          />
        </form>
      )}

      {step === 'prompts' && category && (
        <form method="get" className="flex flex-col gap-6">
          <h2 className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
            A few questions about it
          </h2>
          {CLARIFYING_PROMPTS[category].map((prompt) => (
            <fieldset key={prompt.id} className="flex flex-col gap-2">
              <legend className="font-medium">{prompt.question}</legend>
              {prompt.type === 'select' ? (
                <div className="flex flex-col gap-2">
                  {prompt.options?.map((option) => (
                    <Choice
                      key={option}
                      name={`p_${prompt.id}`}
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
                  name={`p_${prompt.id}`}
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
            <BackButton target="category" onNavigate={goTo} />
            <NextButton
              hydrated={hydrated}
              target="troubleshooting"
              onNavigate={goTo}
              blockedBy={
                CLARIFYING_PROMPTS[category].some((p) => !promptAnswers[p.id]?.trim())
                  ? 'Answer every question above to continue.'
                  : null
              }
            />
          </div>
          <CarriedAnswers answers={answers} owns={(name) => name.startsWith('p_')} />
        </form>
      )}

      {step === 'troubleshooting' && category && (
        <form method="get" className="flex flex-col gap-6">
          <h2 className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
            A few quick things to try first
          </h2>
          <p>This often fixes it without waiting for a visit.</p>
          {steps.map((troubleshootingStep) => (
            <fieldset
              key={troubleshootingStep.id}
              className="flex flex-col gap-3 rounded-md border p-4"
            >
              {/*
                THE LEGEND IS THE FIELDSET'S FIRST CHILD, and that is the whole
                point of it (audit, tenant portal ⑸). It used to sit two divs
                deep next to the illustration, where it names nothing at all -
                so several groups on one screen each offered "I tried this" /
                "Skip this" with no way to hear which step they belonged to.
                This file's own comment claimed the fieldset/legend "was
                already correct"; it was not.
              */}
              <legend className="font-medium">{troubleshootingStep.title}</legend>
              <div className="flex gap-4">
                <TroubleshootingIllustration stepId={troubleshootingStep.id} />
                <p>{troubleshootingStep.instructions}</p>
              </div>
              <div className="flex gap-3">
                <Choice
                  name={`t_${troubleshootingStep.id}`}
                  value="TRIED"
                  checked={troubleshooting[troubleshootingStep.id] === 'TRIED'}
                  onSelect={() =>
                    setTroubleshooting((prev) => ({ ...prev, [troubleshootingStep.id]: 'TRIED' }))
                  }
                >
                  I tried this
                </Choice>
                <Choice
                  name={`t_${troubleshootingStep.id}`}
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
            <BackButton target="prompts" onNavigate={goTo} />
            <NextButton
              hydrated={hydrated}
              target="photos"
              onNavigate={goTo}
              blockedBy={
                steps.some((s) => !troubleshooting[s.id])
                  ? 'Tell us whether you tried each step, or skip it, to continue.'
                  : null
              }
            />
          </div>
          <CarriedAnswers answers={answers} owns={(name) => name.startsWith('t_')} />
        </form>
      )}

      {step === 'photos' && (
        <form method="get" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
              Add a photo (optional)
            </h2>
            <p>This helps us send the right person with the right parts.</p>
          </div>
          {/*
            The one part of this wizard a file cannot be carried through a
            query string for. Skipping it costs the tenant nothing they cannot
            recover: the ticket page takes photos after the fact.
          */}
          <noscript>
            <p>
              Choosing photos needs JavaScript. Carry on without them — you can
              add photos to your request as soon as it is sent.
            </p>
          </noscript>
          {/*
            `focus-within`, not `focus-visible`: the input is `sr-only` inside
            this label, so the thing that actually receives focus is the input
            and a ring on the label never painted (audit, tenant portal ⒂).
            Same reasoning as OPTION_BUTTON above.
          */}
          <label
            className={`${BACK_BUTTON} focus-within:ring-ring cursor-pointer focus-within:ring-2 focus-within:ring-offset-2`}
          >
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
          <LiveRegion>
            {photoStatus && <p className="text-base">{photoStatus}</p>}
          </LiveRegion>
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
                    // Every one of these was called "Remove", so a list of
                    // them is unusable by name alone (audit, tenant portal
                    // ⒁). The visible word stays inside the accessible name,
                    // which is what 2.5.3 asks.
                    aria-label={`Remove ${photo.file.name}`}
                    onClick={() => removePhoto(photo.key)}
                    className="text-muted-foreground hover:text-red-700 min-h-11 rounded-md px-2 underline underline-offset-2"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3">
            {/* Explicitly, not through `goTo`'s skip: clamping only ever
                moves FORWARD past a troubleshooting step that does not apply,
                so a Back aimed at one would land right back here. */}
            <BackButton
              target={steps.length > 0 ? 'troubleshooting' : 'prompts'}
              onNavigate={goTo}
            />
            <NextButton
              hydrated={hydrated}
              target="entry"
              onNavigate={goTo}
              blockedBy={null}
            />
          </div>
          <CarriedAnswers answers={answers} owns={() => false} />
        </form>
      )}

      {step === 'entry' && (
        <form method="get" className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
              Can we come in if you are not home?
            </legend>
            <p>If not, we will need to schedule a time that works for you.</p>
            <div className="flex flex-col gap-2">
              <Choice
                name="entry"
                value="yes"
                checked={entryPermission === true}
                onSelect={() => setEntryPermission(true)}
              >
                Yes, you can enter if I am not home
              </Choice>
              <Choice
                name="entry"
                value="no"
                checked={entryPermission === false}
                onSelect={() => setEntryPermission(false)}
              >
                No, please schedule a time with me
              </Choice>
            </div>
            <div className="flex gap-3">
              <BackButton target="photos" onNavigate={goTo} />
              <NextButton
                hydrated={hydrated}
                target="pets"
                onNavigate={goTo}
                blockedBy={
                  entryPermission === undefined ? 'Choose yes or no to continue.' : null
                }
              />
            </div>
          </fieldset>
          <CarriedAnswers answers={answers} owns={(name) => name === 'entry'} />
        </form>
      )}

      {step === 'pets' && (
        <form method="get" className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
              Do you have a pet at home?
            </legend>
            <p>Whoever comes by needs to know before they open a door.</p>
            <div className="flex flex-col gap-2">
              <Choice
                name="pet"
                value="yes"
                checked={petWarning === true}
                onSelect={() => setPetWarning(true)}
              >
                Yes
              </Choice>
              <Choice
                name="pet"
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
                  name="petNote"
                  value={petNote}
                  onChange={(event) => setPetNote(event.target.value)}
                  placeholder="e.g. large dog, keeps him in the yard"
                  className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                />
              </div>
            )}
            <div className="flex gap-3">
              <BackButton target="entry" onNavigate={goTo} />
              <NextButton
                hydrated={hydrated}
                label="Review"
                target="review"
                onNavigate={goTo}
                blockedBy={petWarning === undefined ? 'Choose yes or no to continue.' : null}
              />
            </div>
          </fieldset>
          <CarriedAnswers
            answers={answers}
            owns={(name) => name === 'pet' || name === 'petNote'}
          />
        </form>
      )}

      {step === 'review' && category && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold" tabIndex={-1} ref={setHeading}>
            Review your request
          </h2>
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
          {/*
            The only POST in the wizard, and the only step whose Back is a
            link: a submit button inside this form would run the action.
            `onSubmit` preventDefault keeps the hydrated path on
            `handleSubmit`, which is what knows about photos still in flight -
            the no-JS path has none by construction.
          */}
          <form
            action={submitMaintenanceRequestForm}
            onSubmit={(event) => {
              event.preventDefault()
              handleSubmit()
            }}
            className="flex gap-3"
          >
            <a
              href={`?${new URLSearchParams([...answerFields(answers), ['step', 'pets']])}`}
              className={BACK_BUTTON}
              onClick={(event) => {
                event.preventDefault()
                goTo('pets')
              }}
            >
              Back
            </a>
            <button type="submit" className={NEXT_BUTTON} disabled={isPending}>
              {isPending ? 'Sending…' : 'Send request'}
            </button>
            <CarriedAnswers answers={answers} owns={() => false} />
          </form>
        </div>
      )}
    </div>
  )
}
