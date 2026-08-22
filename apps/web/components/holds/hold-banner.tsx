import { EFFECT_LABELS, HOLD_DEFINITIONS, type HoldType } from '@rental/core/holds'

// The persistent hold banner (R-084).
//
// ==========================================================================
// A SERVER COMPONENT WITH NO INTERACTION, AND THAT IS DELIBERATE.
//
// It renders on first paint, it cannot be dismissed, and there is nothing to
// hydrate. The thing this is guarding against is somebody serving a notice on
// a bankrupt tenancy while reading a screen that looked ordinary — so a
// banner that arrives after hydration, or that a previous session dismissed,
// is not a banner. `onClick` is inert until hydration (CLAUDE.md), and the
// only correct amount of interaction here is none.
//
// It WARNS and refuses nothing. Serving a notice under any of these holds is
// sometimes lawful — a stay can be lifted, a court can order possession
// against a servicemember, an estate can be served through its
// representative. A product that blocked it would be making the legal
// judgement packages/core/holds says it does not make, and the operator's
// workaround would be to lift the hold, which is strictly worse.
// ==========================================================================

export interface BannerHold {
  type: HoldType
  reason: string
  placedOn: string
  placedByName: string
}

export function HoldBanner({
  holds,
  context,
}: {
  holds: readonly BannerHold[]
  /// What the reader is about to do, when the screen knows. Sharpens the
  /// last line from "be careful" into something specific.
  context?: string
}) {
  if (holds.length === 0) return null

  return (
    <section
      // `role="alert"` would be wrong: this is present on load rather than
      // announced by a change, and an alert role on a static region either
      // says nothing (it never changes) or interrupts on every navigation.
      // A labelled region a screen reader can land on is what a persistent
      // warning actually is.
      aria-labelledby="lease-holds"
      className="flex flex-col gap-3 rounded-md border-2 border-amber-500 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-950"
    >
      <h2 id="lease-holds" className="text-sm font-semibold text-amber-950 dark:text-amber-50">
        {holds.length === 1
          ? 'This tenancy is under a hold'
          : `This tenancy is under ${holds.length} holds`}
      </h2>

      <ul className="flex flex-col gap-3">
        {holds.map((hold) => {
          const definition = HOLD_DEFINITIONS[hold.type]
          return (
            <li key={`${hold.type}-${hold.placedOn}`} className="flex flex-col gap-1">
              <span className="text-sm font-medium text-amber-950 dark:text-amber-50">
                {definition.label}
              </span>
              <span className="text-sm text-amber-900 dark:text-amber-100">
                {definition.banner}
              </span>
              <span className="text-xs text-amber-800 dark:text-amber-200">
                Placed {hold.placedOn} by {hold.placedByName} — “{hold.reason}”
              </span>
              <span className="text-xs text-amber-800 dark:text-amber-200">
                In force: {definition.effects.map((effect) => EFFECT_LABELS[effect]).join('; ')}.
              </span>
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-amber-900 dark:text-amber-100">
        {context ?? 'Nothing here is blocked'} — this is a warning, not a
        refusal. The product does not decide whether the protection applies to
        what you are about to do. Check before you proceed, and record what
        you relied on.
      </p>
    </section>
  )
}
