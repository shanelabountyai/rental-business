import { requirePlatform } from '@/lib/platform/guard.ts'

// PLAT-02 control: the right guard, first. Must pass.
export default async function Page() {
  await requirePlatform()
  return null
}
