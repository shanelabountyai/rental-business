'use client'

import { useEffect, useRef } from 'react'

// What a VENDOR sees when the job page throws (U1, R-099).
//
// The worst instance of the missing-boundary defect, which is why it gets its
// own file rather than inheriting the root one: a plumber standing in a
// driveway, holding a phone, looking at "Application error: a client-side
// exception has occurred". No account to sign into, no navigation to fall
// back to, no history — the magic link IS the whole surface (D-6).
//
// So the only two useful things are here: retry, and a number to call. The
// help line is the same component the rejection screen uses, and renders
// nothing when the number is unset — which is a deployment gap, not a reason
// to print a dead "call the office" (R-098).
//
// THE VARIABLE IS NEXT_PUBLIC_ ON PURPOSE, and it is the same single variable
// the server-rendered help line reads. `error.tsx` is a client component that
// takes no props, so it cannot be handed a server-read value — and a second
// variable holding the same number is the kind of thing that ends up set in
// one place and not the other. A phone number printed on a screen we hand to
// strangers has nothing to protect by being server-only.

const OPERATIONS_PHONE = process.env.NEXT_PUBLIC_OPERATIONS_PHONE?.trim()

export default function VendorError({ reset }: { error: Error; reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        This page did not load
      </h1>

      <p className="text-base">
        Something went wrong on our side. Your job is still there — this is
        the page failing, not the work.
      </p>

      <button
        type="button"
        onClick={() => reset()}
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Try again
      </button>

      {OPERATIONS_PHONE && (
        <p className="text-base">
          Still stuck? Call the office:{' '}
          <a
            href={`tel:${OPERATIONS_PHONE.replace(/[^+\d]/g, '')}`}
            className="focus-visible:ring-ring inline-flex min-h-12 items-center rounded-md font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            {OPERATIONS_PHONE}
          </a>
        </p>
      )}
    </main>
  )
}
