import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DocumentsSection } from '@/components/documents/documents-section.tsx'
import { OperationalDataSection } from '@/components/operational/operational-data-section.tsx'
import { TurnoverPanel } from '@/components/turnover/turnover-panel.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { currentScope as switcherScope } from '@/lib/scope/current-scope.ts'
import { listDeletedDocuments, listDocuments } from '@/lib/documents/queries.ts'
import { listingForUnit } from '@/lib/listings/queries.ts'
import { getOperationalData } from '@/lib/operational/queries.ts'
import { SmartLockPanel } from '@/components/showings/smart-lock-panel.tsx'
import { smartLockPanel } from '@/lib/showings/lock-queries.ts'
import { revokeShowingAccess, syncLockEvents } from '@/lib/showings/staff-actions.ts'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { markTurnoverRentReady, setTurnoverTargetDate } from '@/lib/turnover/actions.ts'
import { getTurnoverForUnit } from '@/lib/turnover/queries.ts'
import { getUnitDetail } from '@/lib/units/queries.ts'
import { createWorkOrder } from '@/lib/workorders/actions.ts'

export const metadata = { title: 'Unit — Rental Operations' }

const STATUS_LABELS: Record<string, string> = {
  OCCUPIED: 'Occupied',
  VACANT: 'Vacant',
  MAKE_READY: 'Make-ready',
  DOWN: 'Down',
}

const LISTING_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft — not public',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Unpublished',
}

/// LEASE-01 (R-056). "Create" only when there is no CURRENT listing - a
/// DRAFT or PUBLISHED one is edited, not duplicated; an UNPUBLISHED one
/// (a prior vacancy, already let) is what re-listing after the next
/// vacancy starts fresh from, so it offers "create" again rather than
/// resurrecting a stale row.
function ListingSection({
  propertyId,
  unitId,
  listing,
  canWrite,
}: {
  propertyId: string
  unitId: string
  listing: { id: string; status: string; rentCents: number } | null
  canWrite: boolean
}) {
  const base = `/properties/${propertyId}/units/${unitId}/listing`
  const canCreate = canWrite && (!listing || listing.status === 'UNPUBLISHED')

  return (
    <section className="flex flex-col gap-1 rounded-md border p-4">
      <h2 className="text-sm font-semibold">Listing</h2>
      {listing ? (
        <>
          <p className="text-muted-foreground text-sm">
            {LISTING_STATUS_LABELS[listing.status] ?? listing.status} — $
            {(listing.rentCents / 100).toLocaleString()}/mo
          </p>
          <div className="flex gap-4 text-sm">
            {(canWrite || listing.status === 'PUBLISHED') && (
              <Link href={`${base}/${listing.id}`} className="underline underline-offset-4">
                {canWrite ? 'Edit listing' : 'View listing'}
              </Link>
            )}
            {listing.status === 'PUBLISHED' && (
              <Link
                href={`/listings/${listing.id}`}
                className="underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                View public page
              </Link>
            )}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Not listed.</p>
      )}
      {canCreate && (
        <Link href={`${base}/new`} className="w-fit text-sm underline underline-offset-4">
          {listing ? 'Create a new listing' : 'Create listing'}
        </Link>
      )}
    </section>
  )
}

/// Same convention as the property detail page: a section this item does not
/// fill in names the item that will, so a half-built product explains itself.
function EmptySection({
  title,
  ownedBy,
  description,
}: {
  title: string
  ownedBy: string
  description: string
}) {
  return (
    <section className="flex flex-col gap-1 rounded-md border p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      <p className="text-muted-foreground text-xs">
        Built by <code className="font-mono">{ownedBy}</code>.
      </p>
    </section>
  )
}

export default async function UnitDetailPage({
  params,
}: {
  params: Promise<{ id: string; unitId: string }>
}) {
  const { id: propertyId, unitId } = await params
  const { actor } = await requireScope('unit.read')
  const scope = await switcherScope(actor)

  const unit = await getUnitDetail(propertyId, unitId, scope)
  if (!unit) notFound()

  const [
    canWrite,
    documents,
    deletedDocuments,
    canWriteDocuments,
    canDeleteDocuments,
    operationalData,
    canReveal,
    listing,
    turnover,
    lockPanel,
    canRevokeAccess,
  ] = await Promise.all([
    actorCan('unit.write', propertyResource(unit.property)),
    listDocuments(propertyId, scope, unitId),
    listDeletedDocuments(propertyId, scope, unitId),
    actorCan('document.write', propertyResource(unit.property)),
    actorCan('document.delete', propertyResource(unit.property)),
    getOperationalData(propertyId, unitId, scope),
    actorCan('accesscode.reveal', propertyResource(unit.property)),
    listingForUnit(unitId, scope),
    getTurnoverForUnit(unitId, unit.property.timezone, new Date()),
    // R-094. Null for every unit nobody has fitted a lock to, which is what
    // keeps self-showings opt-in per unit.
    smartLockPanel(unitId),
    actorCan('lease.write', propertyResource(unit.property)),
  ])

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link
              href={`/properties/${propertyId}`}
              className="underline underline-offset-4"
            >
              {unit.property.name}
            </Link>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{unit.name}</h1>
        </div>
        {canWrite && (
          <Link
            href={`/properties/${propertyId}/units/${unit.id}/edit`}
            className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Edit
          </Link>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[unit.status] ?? unit.status}
        </dd>
        {unit.marketRentCents != null && (
          <>
            <dt className="text-muted-foreground">Market rent</dt>
            <dd className="col-span-1 sm:col-span-2">
              ${(unit.marketRentCents / 100).toLocaleString()}/mo
            </dd>
          </>
        )}
        {(unit.bedrooms != null || unit.bathrooms != null) && (
          <>
            <dt className="text-muted-foreground">Beds / baths</dt>
            <dd className="col-span-1 sm:col-span-2">
              {unit.bedrooms ?? '—'} bed{unit.bedrooms === 1 ? '' : 's'} /{' '}
              {unit.bathrooms != null ? String(unit.bathrooms) : '—'} bath
              {unit.bathrooms?.toString() === '1' ? '' : 's'}
            </dd>
          </>
        )}
        {unit.squareFeet != null && (
          <>
            <dt className="text-muted-foreground">Square feet</dt>
            <dd className="col-span-1 sm:col-span-2">{unit.squareFeet}</dd>
          </>
        )}
        {unit.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="col-span-1 sm:col-span-2">{unit.notes}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-3">
        <DocumentsSection
          propertyId={propertyId}
          unitId={unitId}
          documents={documents}
          deletedDocuments={deletedDocuments}
          canWrite={canWriteDocuments}
          canDelete={canDeleteDocuments}
        />
        {operationalData && (
          <OperationalDataSection
            unitId={unitId}
            accessCodes={operationalData.accessCodes}
            appliances={operationalData.appliances}
            utilityAccounts={operationalData.utilityAccounts}
            shutoffs={operationalData.shutoffs}
            canWrite={canWrite}
            canReveal={canReveal}
          />
        )}
        <ListingSection
          propertyId={propertyId}
          unitId={unitId}
          listing={listing}
          canWrite={canWrite}
        />
        {turnover && (
          <TurnoverPanel
            unitId={unitId}
            canWrite={canWrite}
            turnover={{
              id: turnover.id,
              targetRentReadyDate: turnover.targetRentReadyDate,
              rentReadyAt: turnover.rentReadyAt ? turnover.rentReadyAt.toISOString() : null,
              moveOutDate: turnover.moveOutDate,
              daysVacant: turnover.daysVacant,
              daysVacantIsFinal: turnover.daysVacantIsFinal,
              totalCostCents: turnover.totalCostCents,
              items: turnover.items,
            }}
            setTargetDateAction={setTurnoverTargetDate.bind(null, turnover.id)}
            markRentReadyAction={markTurnoverRentReady.bind(null, turnover.id)}
            addItemAction={createWorkOrder}
          />
        )}
        {lockPanel && (
          <SmartLockPanel
            label={`${lockPanel.lock.label} · ${lockPanel.lock.provider.toLowerCase()} · ${
              lockPanel.lock.active
                ? 'active — vacant viewings here are self-serve'
                : 'inactive — viewings here are escorted'
            }`}
            canRevoke={canRevokeAccess}
            accesses={lockPanel.accesses.map((access) => ({
              showingId: access.showingId,
              revokeAction: revokeShowingAccess.bind(null, access.showingId),
              prospectName: `${access.showing.prospect.firstName} ${access.showing.prospect.lastName}`,
              when: friendlyTimestamp(access.showing.scheduledStart, unit.property.timezone),
              window: `${friendlyTimestamp(access.validFrom, unit.property.timezone)} – ${friendlyTimestamp(access.validTo, unit.property.timezone)}`,
              live: access.revokedAt == null,
              revoked: access.revokedAt
                ? {
                    at: friendlyTimestamp(access.revokedAt, unit.property.timezone),
                    reason: access.revokedReason ?? '',
                    by: access.revokedBy?.name ?? null,
                    reachedDevice: access.revokeReachedDevice,
                  }
                : null,
              // The name on the document, not just "verified": a later
              // question about who was let in is answered by the name they
              // showed, and it is already on the row.
              identity: `${access.identityCheck.result.toLowerCase().replace(/_/g, ' ')} as ${access.identityCheck.documentName}`,
            }))}
            events={lockPanel.events.map((event) => ({
              id: event.id,
              kind: event.kind,
              when: friendlyTimestamp(event.occurredAt, unit.property.timezone),
              actorLabel: event.actorLabel,
              who: event.access
                ? `${event.access.showing.prospect.firstName} ${event.access.showing.prospect.lastName} (viewing)`
                : event.tenantCode
                  ? `${event.tenantCode.tenant.firstName} ${event.tenantCode.tenant.lastName}`
                  : null,
            }))}
            syncAction={syncLockEvents.bind(null, unitId)}
          />
        )}
        <EmptySection
          title="Lease"
          ownedBy="R-033"
          description="The current and past tenancies at this unit."
        />
        <EmptySection
          title="Maintenance"
          ownedBy="R-022"
          description="Tickets and work orders for this unit."
        />
      </div>
    </div>
  )
}
