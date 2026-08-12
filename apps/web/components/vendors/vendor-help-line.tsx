// The way out of a vendor dead end (D-6, R-098).
//
// Every rejection screen on the vendor surface said "call the office" and
// gave no number. A vendor whose link expired — which is the NORMAL case, not
// an edge one: the TTL is three days and "accept now, invoice next week" is
// how the work actually goes — was left at a screen whose only instruction
// was unactionable.
//
// A `tel:` link, so it dials on the phone they are already holding. The token
// is invalid at this point so there is no property to look up; this is one
// operations number for the whole portfolio.
//
// Renders nothing when unset rather than an empty link. Better to say less
// than to show a dead control — and the deployment checklist in .env.example
// is where this belongs, not a hardcoded fallback nobody would notice was
// wrong.

export function VendorHelpLine() {
  const phone = process.env.NEXT_PUBLIC_OPERATIONS_PHONE?.trim()
  if (!phone) return null

  return (
    <p className="text-base">
      Call the office and we will sort it out:{' '}
      <a
        href={`tel:${phone.replace(/[^+\d]/g, '')}`}
        className="focus-visible:ring-ring inline-flex min-h-12 items-center rounded-md font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        {phone}
      </a>
    </p>
  )
}
