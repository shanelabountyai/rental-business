// The closed set of US state/territory codes. Shared by Property.state and
// LegalEntity.formationState here, and by R-010's JurisdictionRule later -
// state drives every jurisdiction lookup (D-4), so "TX" vs "Tx" vs "Texas"
// cannot be three different strings floating around the product.

export const US_STATES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
} as const

export type UsStateCode = keyof typeof US_STATES

const STATE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(US_STATES))

export function isUsStateCode(value: string): value is UsStateCode {
  return STATE_CODE_SET.has(value)
}

export const US_STATE_OPTIONS: readonly { code: UsStateCode; name: string }[] =
  Object.entries(US_STATES).map(([code, name]) => ({
    code: code as UsStateCode,
    name,
  }))
