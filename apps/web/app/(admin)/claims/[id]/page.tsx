import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  ClaimDetailsPanel,
  ClaimHeader,
  CloseClaimPanel,
  LossOfRentsPanel,
  LossPhotosPanel,
  MitigationPanel,
  PaymentsPanel,
  PositionPanel,
  TimelinePanel,
} from '@/components/insurance/claim-panels.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import {
  closeClaim,
  linkWorkOrder,
  logClaimEvent,
  recordClaimPayment,
  recordLossOfRents,
  unlinkWorkOrder,
  updateClaimDetails,
  uploadLossPhoto,
} from '@/lib/insurance/actions.ts'
import { getClaim } from '@/lib/insurance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Claim — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound(), and a
// Suspense boundary above it puts a 200 on the wire before the page runs.
export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requirePermission('property.read')
  const scope = await currentScope(actor)
  const claim = await getClaim(id, scope)
  if (!claim) notFound()

  const [linkableJobs, units] = await Promise.all([
    prisma.workOrder.findMany({
      where: { propertyId: claim.propertyId, insuranceClaimId: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, scope: true, status: true },
    }),
    prisma.unit.findMany({
      where: { propertyId: claim.propertyId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href="/claims"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← Claims
      </Link>

      <ClaimHeader claim={claim} />

      {/* First, deliberately. An owner opening a fresh water claim has one
          useful next action and it is not the adjuster's phone number. */}
      <MitigationPanel claim={claim} />
      <LossPhotosPanel claim={claim} action={uploadLossPhoto} />
      <PositionPanel
        claim={claim}
        linkAction={linkWorkOrder}
        unlinkAction={unlinkWorkOrder}
        linkableJobs={linkableJobs.map((job) => ({
          id: job.id,
          label: `${job.scope} (${job.status.toLowerCase().replace(/_/g, ' ')})`,
        }))}
      />
      <PaymentsPanel claim={claim} action={recordClaimPayment} />
      <LossOfRentsPanel claim={claim} units={units} action={recordLossOfRents} />
      <TimelinePanel claim={claim} action={logClaimEvent} />
      <ClaimDetailsPanel claim={claim} action={updateClaimDetails} />

      {claim.status === 'OPEN' && <CloseClaimPanel claim={claim} action={closeClaim} />}
    </div>
  )
}
