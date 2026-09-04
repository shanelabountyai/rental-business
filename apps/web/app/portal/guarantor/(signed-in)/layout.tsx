import type { Metadata, Viewport } from 'next'
import { PortalNav } from '@/components/portal/portal-nav.tsx'
import { signOutGuarantor } from '@/lib/portal/actions.ts'
import { GUARANTOR_NAV_ITEMS } from '@/lib/portal/guarantor-nav.ts'
import { requireGuarantor } from '@/lib/portal/guarantor-guard.ts'

// The guarantor portal shell (R-165, LEASE-06).
//
// A route group, so /portal/guarantor/login and /portal/guarantor/verify
// stay OUTSIDE it, same reason as the tenant shell.
//
// SAME ACCESSIBILITY FLOOR AS THE TENANT SHELL - 16px base, 44px targets, no
// colour-only status, landmarks and a skip link - a guarantor is read by the
// same range of people the tenant portal is built for and has no lower bar
// to clear.
//
// NO loading.tsx HERE, deliberately (CLAUDE.md's own warning): the notices
// detail page below calls notFound() on a scope miss (ROLE-01), and a
// Suspense boundary above it would turn that into a silent 200.

export const metadata: Metadata = {
  title: 'What you guarantee',
  description: 'The balance, ledger and notices for the lease you guarantee.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
}

export default async function GuarantorPortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // A floor, not a ceiling: this proves the visitor is a guarantor, and
  // nothing about WHICH lease they may see. Every page below scopes its own
  // queries by requireGuarantorWithScope().
  const guarantor = await requireGuarantor()

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="bg-background focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-4 focus:py-3 focus:text-base focus:ring-2"
      >
        Skip to content
      </a>

      <header className="border-border border-b">
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-base font-semibold tracking-tight">{guarantor.name}</p>
          <form action={signOutGuarantor}>
            <button
              type="submit"
              className="border-input hover:bg-secondary focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <PortalNav items={GUARANTOR_NAV_ITEMS} />

      <main
        id="main"
        className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 pb-24 text-base sm:pb-6"
      >
        {children}
      </main>
    </div>
  )
}
