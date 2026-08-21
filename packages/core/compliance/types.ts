// The compliance-item vocabulary (PROP-05, R-077). Free-form on the schema
// (`ComplianceItem.type`, matching `Notice.type`'s own posture) precisely
// so an obligation this product has never heard of needs no migration -
// this list is what the admin form offers, never a closed set the
// database enforces.

export const COMPLIANCE_ITEM_TYPES = [
  'RENTAL_LICENSE',
  'RENTAL_REGISTRATION',
  'CO_INSPECTION',
  'PERIODIC_CITY_INSPECTION',
  'SMOKE_CO_CERTIFICATION',
  'LEAD_DISCLOSURE',
  'HOA_OBLIGATION',
  'PROPERTY_TAX',
  'PROPERTY_TAX_APPEAL_WINDOW',
  'SECTION_8_INSPECTION',
  'SECTION_8_RECERTIFICATION',
  /// Entity-scoped (`legalEntityId`, never `propertyId`).
  'LLC_ANNUAL_REPORT',
  'REGISTERED_AGENT_RENEWAL',
  'OTHER',
] as const
export type ComplianceItemTypeValue = (typeof COMPLIANCE_ITEM_TYPES)[number]

export const COMPLIANCE_ITEM_TYPE_LABELS: Record<string, string> = {
  RENTAL_LICENSE: 'Rental license',
  RENTAL_REGISTRATION: 'Rental registration',
  CO_INSPECTION: 'Certificate of occupancy inspection',
  PERIODIC_CITY_INSPECTION: 'Periodic city inspection',
  SMOKE_CO_CERTIFICATION: 'Smoke/CO detector certification',
  LEAD_DISCLOSURE: 'Lead disclosure (pre-1978)',
  HOA_OBLIGATION: 'HOA obligation',
  PROPERTY_TAX: 'Property tax due date',
  PROPERTY_TAX_APPEAL_WINDOW: 'Property tax assessment-appeal window',
  SECTION_8_INSPECTION: 'Section 8 (HCV) inspection',
  SECTION_8_RECERTIFICATION: 'Section 8 (HCV) recertification',
  LLC_ANNUAL_REPORT: 'LLC annual report',
  REGISTERED_AGENT_RENEWAL: 'Registered agent renewal',
  OTHER: 'Other',
}

/// Types that belong to the LEGAL ENTITY, never a single property - the
/// form reads this to decide which scope picker to show.
export const ENTITY_LEVEL_TYPES: ReadonlySet<string> = new Set([
  'LLC_ANNUAL_REPORT',
  'REGISTERED_AGENT_RENEWAL',
])

export function isComplianceItemType(value: string): value is ComplianceItemTypeValue {
  return (COMPLIANCE_ITEM_TYPES as readonly string[]).includes(value)
}

export function complianceItemTypeLabel(type: string): string {
  return COMPLIANCE_ITEM_TYPE_LABELS[type] ?? type
}
