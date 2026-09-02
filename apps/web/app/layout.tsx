import type { Metadata } from 'next'
import { Albert_Sans } from 'next/font/google'
import './globals.css'

// Homestead (D-163): one humanist face for display, body and labels. Albert
// Sans is a variable font, so the four weights D-163 names (400-700) come in
// one file; next/font self-hosts it at build time, so nothing is fetched from
// Google at runtime. globals.css points --font-sans at this variable.
const albertSans = Albert_Sans({
  subsets: ['latin'],
  variable: '--font-albert',
})

export const metadata: Metadata = {
  title: 'Rental Operations Platform',
  description:
    'Operations platform for a multi-property single-family rental business.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={albertSans.variable}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
