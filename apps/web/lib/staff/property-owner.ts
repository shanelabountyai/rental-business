import 'server-only'

import { prisma } from '@rental/db'

/**
 * THE OWNER IS A PERSON, not the LLC (D-331): the staff user holding an
 * active `owner` grant, narrowest scope first — this property, then its
 * entity, then the whole deployment — and the earliest grant within a
 * scope, so the same property always names the same person. Shared by the
 * `{{owner.*}}` merge fields and the application-review Task (R-269).
 */
export async function propertyOwner(property: { id: string; legalEntityId: string; orgId: string }) {
  const ownerGrants = await prisma.staffAssignment.findMany({
    where: {
      // R-285b: "the whole deployment" is the property's org - never an owner
      // of somebody else's portfolio.
      orgId: property.orgId,
      revokedAt: null,
      role: { key: 'owner' },
      staffUser: { active: true },
      OR: [
        { propertyId: property.id },
        { propertyId: null, legalEntityId: property.legalEntityId },
        { propertyId: null, legalEntityId: null },
      ],
    },
    orderBy: { grantedAt: 'asc' },
    select: {
      propertyId: true,
      legalEntityId: true,
      staffUser: { select: { id: true, name: true, phone: true } },
    },
  })
  return (
    (
      ownerGrants.find((grant) => grant.propertyId) ??
      ownerGrants.find((grant) => grant.legalEntityId) ??
      ownerGrants[0]
    )?.staffUser ?? null
  )
}
