'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// What STAFF see when an admin page throws (U1, R-099).
//
// Different job from the tenant's version. A tenant needs reassurance and a
// phone number; whoever is on this side needs to know whether to retry or to
// go and look at something. So this one says the digest out loud — it is the
// only handle on the server-side stack trace, it is not sensitive by design
// (Next redacts the message in production and leaves the digest), and an
// operator who can read it to somebody has turned "it broke" into a
// searchable log line.

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader ref={heading} focusable title="This page failed to load" />

      <p className="text-sm">
        The request did not complete. Nothing was written — a page that throws
        while rendering has not changed any record.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 items-center px-4 py-2 text-sm`}
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="border-input hover:bg-secondary focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Back to dashboard
        </Link>
      </div>

      {error.digest && (
        <button
          type="button"
          aria-live="polite"
          onClick={() => {
            navigator.clipboard.writeText(error.digest!)
            setCopied(true)
          }}
          className="border-input hover:bg-secondary focus-visible:ring-ring flex min-h-11 w-fit items-center gap-2 rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {copied ? 'Copied' : 'Copy reference'} <code className="font-mono">{error.digest}</code>
        </button>
      )}
    </div>
  )
}
