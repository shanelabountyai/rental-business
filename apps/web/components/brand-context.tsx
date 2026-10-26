'use client'

import { createContext, useContext } from 'react'

// The two brand facts a client component needs (R-289). Error boundaries are
// client components that take no props, so they read the org's support number
// from here rather than from a build-time variable. Null outside the root
// layout, which is where `global-error.tsx` renders.
export type ClientBrand = { name: string; supportPhone: string | null }

const BrandContext = createContext<ClientBrand | null>(null)

export function BrandProvider({ brand, children }: { brand: ClientBrand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}

export function useBrand(): ClientBrand | null {
  return useContext(BrandContext)
}
