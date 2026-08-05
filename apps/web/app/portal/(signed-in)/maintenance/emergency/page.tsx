import {
  EMERGENCY_CATEGORIES,
  type EmergencyCategory,
} from '@rental/core/maintenance'
import Link from 'next/link'
import {
  EmergencyFlow,
  type ShutoffInfo,
} from '@/components/portal/maintenance/emergency-flow.tsx'
import { shutoffForEmergency, unitForEmergency } from '@/lib/maintenance/emergency.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

export const metadata = { title: 'Emergency' }

// MAINT-01's emergency intake (R-020).
//
// Every category's shutoff is resolved HERE, on the server, before the page
// renders - not fetched when the tenant picks one. A tenant standing in
// rising water must not wait on a round trip to be told where their stop tap
// is, and this is a handful of small indexed lookups against one unit.

export default async function EmergencyPage() {
  const { scope } = await requireTenantWithScope()
  const home = await unitForEmergency(scope)

  if (!home) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Emergency</h1>
        <p>
          We do not have a home on file for you yet, so we cannot route this
          to the right person. Please call 911 if anyone is in danger, then
          call or text the number on your lease.
        </p>
      </div>
    )
  }

  const resolved = await Promise.all(
    EMERGENCY_CATEGORIES.map(
      async (category) =>
        [category, await shutoffForEmergency(home.unitId, category)] as const,
    ),
  )
  const shutoffs: Partial<Record<EmergencyCategory, ShutoffInfo>> = {}
  for (const [category, shutoff] of resolved) {
    if (shutoff) shutoffs[category] = shutoff
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Emergency</h1>
        {/*
          Said before anything else on the page, and not only inside a
          category's own instructions: somebody who lands here by accident,
          or whose situation is not on the list, still needs to read it.
        */}
        <p className="rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 font-medium text-red-950 dark:bg-red-950 dark:text-red-50">
          If anyone is in danger, call 911 first. This page does not reach
          emergency services.
        </p>
      </div>

      <EmergencyFlow shutoffs={shutoffs} />

      <p>
        Not an emergency?{' '}
        <Link
          href="/portal/maintenance/new"
          className="focus-visible:ring-ring rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Report an ordinary problem instead
        </Link>
        .
      </p>
    </div>
  )
}
