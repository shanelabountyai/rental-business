import 'server-only'

import { ROLE_DEFINITIONS } from '@rental/core/rbac'
import { grantScopeOptions } from '@/lib/staff/queries.ts'
import { STAFF_ROLE_KEYS } from '@/lib/staff/rules.ts'

// The two selects both forms share. Built here rather than twice, because a
// scope list that differs between "invite" and "grant" is how somebody ends up
// unable to give a colleague the access they were just invited without.

export function roleOptions() {
  return STAFF_ROLE_KEYS.map((key) => ({
    value: key,
    label: ROLE_DEFINITIONS[key].name,
  }))
}

export async function scopeOptions() {
  const { properties, legalEntities } = await grantScopeOptions()
  return [
    { value: 'all', label: 'All properties (portfolio-wide)' },
    ...legalEntities.map((entity) => ({
      value: `entity:${entity.id}`,
      label: `Legal entity — ${entity.name}`,
    })),
    ...properties.map((property) => ({
      value: `property:${property.id}`,
      label: `Property — ${property.name}`,
    })),
  ]
}
