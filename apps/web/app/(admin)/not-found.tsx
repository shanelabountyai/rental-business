import Link from 'next/link'

// The staff 404 (U1, R-099).
//
// Twelve of the fourteen `notFound()` calls in the product are on this side,
// and most of them are not really "no such record" — they are ROLE-01 scope
// refusals. A property-scoped manager opening a lease at another property
// gets `notFound()` on purpose, because "forbidden" would confirm the record
// exists and that is the leak the scoping is there to prevent.
//
// Which means this screen has to be truthful without being helpful to
// somebody probing ids: it names both possibilities and picks neither.

export default function AdminNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>

      <p className="text-sm">
        This record does not exist, or it is outside the properties you have
        access to. If you expected to see it, ask whoever manages access
        rather than retrying — the answer will be the same.
      </p>

      <Link
        href="/tasks"
        className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 w-fit items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Back to your queue
      </Link>
    </div>
  )
}
