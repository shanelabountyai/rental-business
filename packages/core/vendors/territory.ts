// Vendor territory matching (MAINT-08, R-080) - "assigned by vendor
// territory" for a preventive-maintenance batch. `Vendor.serviceAreas` (R-079)
// is the only existing candidate for "territory": free-form city or zip
// strings, never used for matching until now.

export interface TerritoryVendor {
  serviceAreas: readonly string[]
}

export interface TerritoryProperty {
  city: string
  postalCode: string
}

/**
 * Whether a vendor's stated service areas cover a property.
 *
 * No stated areas means no stated RESTRICTION, not no coverage - the same
 * "absence of a fact is not exclusion" posture `preferredRank: null` and
 * `fallbackVendorsForTrade`'s `trade: null` already take (R-079/D-68). A
 * vendor who has never been asked where they work is not thereby excluded
 * from every batch.
 */
export function vendorCoversProperty(vendor: TerritoryVendor, property: TerritoryProperty): boolean {
  if (vendor.serviceAreas.length === 0) return true
  const areas = vendor.serviceAreas.map((a) => a.trim().toLowerCase())
  return areas.includes(property.city.trim().toLowerCase()) || areas.includes(property.postalCode.trim())
}
