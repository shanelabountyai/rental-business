import Link from 'next/link'
import { InviteStaffForm } from '@/components/staff/invite-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { inviteStaff } from '@/lib/staff/actions.ts'
import { roleOptions, scopeOptions } from '@/lib/staff/options.ts'

export const metadata = { title: 'Add staff member — Rental Operations' }

export default async function NewStaffPage() {
  // `staff.manage` is on PRIVILEGED_PERMISSIONS, so an owner who has not
  // enrolled a second factor is redirected to enrol rather than refused
  // (ROLE-05). That is the guard doing its job, not a bug in this page.
  await requirePermission('staff.manage')
  const scopes = await scopeOptions()

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/staff"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Staff
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add staff member</h1>
        <p className="text-muted-foreground text-sm">
          They set their own password from a single-use link. No password is ever chosen for
          them here.
        </p>
      </header>
      <InviteStaffForm action={inviteStaff} roleOptions={roleOptions()} scopeOptions={scopes} />
    </div>
  )
}
