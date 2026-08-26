'use client'

// The last boundary in the application (R-099).
//
// Only fires when the ROOT layout itself throws, at which point no other
// boundary exists and Next has rendered nothing — so this file has to supply
// its own <html> and <body>. Everything else is caught closer to where it
// happened, by the per-audience error.tsx files that can afford real chrome.
//
// Deliberately styleless: globals.css is loaded by the root layout, which is
// the thing that just failed. Inline styles are the only ones guaranteed to
// arrive, and a legible plain page beats a styled one that renders as an
// unstyled stack of blue links.
//
// THE FALLBACK FOR "JAVASCRIPT BROKE" CANNOT BE A JAVASCRIPT BUTTON (R-114,
// audit angle 10). `reset` is worth offering - a transient render failure does
// recover - but if the failure is in the bundle then the only control on the
// last page in the application does nothing when pressed and explains nothing.
// A plain `<a href>` needs no bundle and the operations number needs no network
// at all. The vendor dead end next door already offered all three; this page,
// the one that fires when everything else is gone, offered none of them.
//
// VendorHelpLine's Tailwind classes are inert here, for the reason above. It is
// reused anyway: what it carries is the number and the `tel:`, and one place
// reading NEXT_PUBLIC_OPERATIONS_PHONE is worth more than a second copy that
// happens to match the inline styles.

import { VendorHelpLine } from '@/components/vendors/vendor-help-line.tsx'

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          fontSize: '16px',
          lineHeight: 1.5,
          margin: 0,
          padding: '2rem',
          maxWidth: '40rem',
        }}
      >
        {/* Focused because this boundary also fires client-side, after a
            press, with focus sitting on a control that no longer exists. */}
        <h1 tabIndex={-1} autoFocus style={{ fontSize: '1.5rem', marginTop: 0 }}>
          Something went wrong
        </h1>
        <p>
          The page could not load. Nothing you were doing has been lost — this
          failed before it could change anything.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            minHeight: '44px',
            padding: '0 1.5rem',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <p>
          {/* A plain anchor, not `next/link`, and the lint rule is wrong here:
              `<Link>` is a client component that needs the router - the very
              thing that has just failed. A full document load is the point. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Go back to the start</a>
        </p>
        <VendorHelpLine />
      </body>
    </html>
  )
}
