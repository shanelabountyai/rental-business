'use client'

import { useEffect, useRef } from 'react'
import { PageHeader } from '@/components/page-header.tsx'
import { VendorHelpLine } from '@/components/vendors/vendor-help-line.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

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

export default function VendorError({ reset }: { error: Error; reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <PageHeader ref={heading} focusable title="This page did not load" />

      <p className="text-base">
        Something went wrong on our side. Your job is still there — this is
        the page failing, not the work.
      </p>

      <button
        type="button"
        onClick={() => reset()}
        className={`${SUBMIT_BUTTON_CLASSES} flex min-h-12 items-center justify-center px-6 py-2 text-base`}
      >
        Try again
      </button>

      <VendorHelpLine />
    </main>
  )
}
