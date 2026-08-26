import Link from 'next/link'
import { requirePermission } from '@/lib/auth/guard.ts'
import { listVendors } from '@/lib/vendors/staff-queries.ts'

export const metadata = { title: 'Vendors — Rental Operations' }

// "As a PM, I manage vendor records" (MAINT-11, R-079) - trades, service
// areas, W-9/COI status, license, preferred rank. No admin surface for
// this existed before this item; a vendor row could only ever be created
// directly in the database.
export default async function VendorsPage() {
  await requirePermission('vendor.read')
  const vendors = await listVendors()
  const today = new Date()

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <Link
          href="/vendors/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Add vendor
        </Link>
      </div>

      {vendors.length === 0 ? (
        <p className="text-muted-foreground text-sm">No vendors on file yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {vendors.map((vendor) => {
            const coiExpired = vendor.coiExpiresOn != null && vendor.coiExpiresOn < today
            return (
              <li key={vendor.id}>
                <Link
                  href={`/vendors/${vendor.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {vendor.name}
                    {!vendor.active && <span className="text-muted-foreground"> (inactive)</span>}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {vendor.trades.join(', ') || 'No trades on file'}
                    {!vendor.w9OnFile && (
                      <span className="text-amber-800"> · no W-9</span>
                    )}
                    {coiExpired && (
                      <span className="text-amber-800"> · COI expired</span>
                    )}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
