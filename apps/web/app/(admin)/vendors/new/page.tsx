import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { VendorRecordForm } from '@/components/vendors/vendor-record-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { saveVendorRecord } from '@/lib/vendors/staff-actions.ts'

export const metadata = { title: 'New vendor — Rental Operations' }

export default async function NewVendorPage() {
  await requirePermission('vendor.write')

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/vendors"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Vendors
        </Link>
        <PageHeader title="New vendor" />
      </header>
      <VendorRecordForm action={saveVendorRecord.bind(null, null)} defaults={{}} submitLabel="Add vendor" />
    </div>
  )
}
