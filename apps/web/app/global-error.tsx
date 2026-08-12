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
        <h1 style={{ fontSize: '1.5rem', marginTop: 0 }}>Something went wrong</h1>
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
      </body>
    </html>
  )
}
