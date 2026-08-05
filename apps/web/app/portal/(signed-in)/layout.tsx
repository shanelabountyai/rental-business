import type { Metadata, Viewport } from 'next'
import { PortalNav } from '@/components/portal/portal-nav.tsx'
import { signOutTenant } from '@/lib/portal/actions.ts'
import { PORTAL_NAV_ITEMS } from '@/lib/portal/nav.ts'
import { requireTenant } from '@/lib/portal/guard.ts'

// The tenant portal shell (R-018, PRD §6.4, D-8, D-10).
//
// A route group, so /portal/login and /portal/verify stay OUTSIDE it - a
// sign-in page inside a layout that requires a session is a redirect loop.
//
// THIS IS WHERE THE ACCESSIBILITY STANDARD IS SET, not retrofitted later
// (the backlog says so in as many words). Everything R-019 and after adds to
// the portal inherits it:
//
//   16px base minimum. `text-base` everywhere, never `text-sm`, which is the
//   staff shell's default and is 14px. A tenant portal is read by people of
//   every age on every handset, and the staff default is not good enough here.
//
//   44px touch targets, via min-h-11 (44px) or larger on anything tappable.
//
//   No colour-only status encoding. Every state carries a word or a shape as
//   well as a colour.
//
//   Landmarks and a skip link, so a screen-reader user reaches the content
//   without walking the navigation on every page.
//
//   Plain language, at roughly an 8th-grade reading level (§6.4), and D-10's
//   lexicon: home, rent, maintenance request, balance, payment. Never "unit",
//   "door", "ticket", "work order", "delinquency", "disposition".

export const metadata: Metadata = {
  title: 'Your home',
  description: 'Your home, your papers, and messages with your landlord.',
  // D-8: a PWA, so it can be added to a home screen with no app-store wall.
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Your home', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately NOT maximumScale/userScalable - pinch-zoom must keep
  // working. Disabling it is the single most common accessibility failure on
  // mobile web, and it fails WCAG 1.4.4 outright.
  themeColor: '#ffffff',
}

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // A floor, not a ceiling: this proves the visitor is a tenant, and nothing
  // about WHICH records they may see. Every page below scopes its own queries
  // - the same split the admin shell's layout guard makes for the same reason.
  const tenant = await requireTenant()

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
          <p className="text-base font-semibold tracking-tight">
            {tenant.name}
          </p>
          <form action={signOutTenant}>
            <button
              type="submit"
              className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <PortalNav items={PORTAL_NAV_ITEMS} />

      {/*
        pb-24 on mobile clears the fixed bottom bar - without it the last row
        of every list sits underneath the navigation and cannot be tapped.
      */}
      <main
        id="main"
        className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 pb-24 text-base sm:pb-6"
      >
        {children}
      </main>
    </div>
  )
}
