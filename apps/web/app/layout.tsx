import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Rental Operations Platform',
  description:
    'Operations platform for a multi-property single-family rental business.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
