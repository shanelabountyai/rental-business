import { requireStaff } from '@/lib/auth/guard.ts'

// PLAT-02 control: a console page behind the ORG guard. ORG-05 passes it; PLAT-02 must not.
export default async function Page() {
  await requireStaff()
  return null
}
