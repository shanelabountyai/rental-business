// public: the root layout renders no data beyond the host's public brand
import type { Metadata } from 'next'
import { Albert_Sans } from 'next/font/google'
import './globals.css'

import { BrandProvider } from '@/components/brand-context.tsx'
import { brandStyle, currentBrand } from '@/lib/brand.ts'

// Homestead (D-163): one humanist face for display, body and labels. Albert
// Sans is a variable font, so the four weights D-163 names (400-700) come in
// one file; next/font self-hosts it at build time, so nothing is fetched from
// Google at runtime. globals.css points --font-sans at this variable.
const albertSans = Albert_Sans({
  subsets: ['latin'],
  variable: '--font-albert',
})

// The org's name is every page's title suffix (R-289): pages set only their
// own words, and the template adds whose product it is.
export async function generateMetadata(): Promise<Metadata> {
  const { name } = await currentBrand()
  return {
    title: { default: name, template: `%s — ${name}` },
    description: `${name}: property management for the homes we look after.`,
  }
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const brand = await currentBrand()
  return (
    <html lang="en" className={albertSans.variable} style={brandStyle(brand)}>
      <body className="min-h-screen antialiased">
        <BrandProvider brand={{ name: brand.name, supportPhone: brand.supportPhone }}>
          {children}
        </BrandProvider>
      </body>
    </html>
  )
}
