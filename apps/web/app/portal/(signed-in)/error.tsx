'use client'

import { useEffect, useRef } from 'react'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// What a TENANT sees when a portal page throws (U1, R-099).
//
// Before this file existed the answer was Next's built-in "Application
// error: a client-side exception has occurred" — a sentence written for the
// developer, shown to the person who lives there.
//
// Three things this owes a tenant that the default gives none of:
//
//   The portal's own chrome, because error.tsx renders inside the layout it
//   belongs to. The navigation, the sign-out, the 16px floor are all still
//   there, so this is a bad moment rather than a dead end.
//
//   THE PHONE. D-10's premise is that the portal is a convenience and never
//   the only way to reach a landlord, and the home page says so in as many
//   words: "you do not have to use this site". The one screen where that is
//   most true is the screen that just failed.
//
//   Focus, moved here deliberately. A thrown page swaps the whole main
//   region; without this the tenant's focus falls to <body> and a screen
//   reader announces nothing at all, so the failure is silent as well as
//   opaque. This is S1's fix applied at the place it matters most.

export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {/* tabIndex -1 so it can take focus without joining the tab order. */}
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>

      <p className="text-base">
        This page could not load. It is a problem on our side, not something
        you did, and nothing you were working on has been changed.
      </p>

      <button
        type="button"
        onClick={() => reset()}
        className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 w-full items-center justify-center px-6 py-2 text-base sm:w-auto`}
      >
        Try again
      </button>

      <p className="text-base">
        If it keeps happening, call or text the number on your lease. You do
        not have to use this site to reach us.
      </p>

      {/* Emergencies do not wait for a working web page. */}
      <p className="text-base font-medium">
        If this is an emergency — gas, fire, flooding, or anything unsafe —
        call 911 first, then call the number on your lease.
      </p>
    </div>
  )
}
