import { describe, expect, it } from 'vitest'
import { vendorCoversProperty } from './territory.ts'

describe('vendorCoversProperty', () => {
  it('covers everywhere when no service area is stated', () => {
    expect(vendorCoversProperty({ serviceAreas: [] }, { city: 'Houston', postalCode: '77002' })).toBe(true)
  })

  it('matches by city, case-insensitively', () => {
    expect(vendorCoversProperty({ serviceAreas: ['houston'] }, { city: 'Houston', postalCode: '77002' })).toBe(
      true,
    )
  })

  it('matches by postal code', () => {
    expect(vendorCoversProperty({ serviceAreas: ['77002'] }, { city: 'Houston', postalCode: '77002' })).toBe(true)
  })

  it('refuses a property in neither the stated cities nor zips', () => {
    expect(
      vendorCoversProperty({ serviceAreas: ['Dallas', '75201'] }, { city: 'Houston', postalCode: '77002' }),
    ).toBe(false)
  })
})
