'use client'

import { useEffect, useRef } from 'react'

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
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight">
        This page failed to load
      </h1>

      <p className="text-sm">
        The request did not complete. Nothing was written — a page that throws
        while rendering has not changed any record.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Try again
        </button>
      </div>

      {error.digest && (
        <p className="text-muted-foreground text-sm">
          Reference: <code className="font-mono">{error.digest}</code> — quote
          this when reporting it; it identifies the failure in the server log.
        </p>
      )}
    </div>
  )
}
