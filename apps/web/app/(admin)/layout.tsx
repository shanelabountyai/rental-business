import Link from 'next/link'
import { Nav } from '@/components/shell/nav.tsx'
import { PropertySwitcher } from '@/components/shell/property-switcher.tsx'
import { NAV_ITEMS } from '@/lib/nav.ts'
import { requireStaff } from '@/lib/auth/guard.ts'
import { currentActor } from '@/lib/auth/actor.ts'
import { selectScope } from '@/lib/scope/actions.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { can } from '@rental/core/rbac'

// The admin shell. Everything under (admin) renders inside it.
//
// The route group carries no URL segment, so /dashboard is /dashboard - the
// grouping exists to give every staff screen one layout and one guard rather
// than repeating both.
//
// `requireStaff()` here protects the whole subtree, but it is a floor, not a
// ceiling: a layout guard proves you are staff, and nothing more. Each page
// still asserts its own permission, because a layout cannot know what the page
// below it is about to show (ROLE-01: server-side per role AND record scope).

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const actor = await requireStaff()
  const scope = await currentScope(actor)

  // Filtered on the server: a maintenance tech is never sent the markup for a
  // financial section, so there is nothing to reveal in the DOM.
  const visibleItems = NAV_ITEMS.filter(
    (item) => can(actor, item.permission).allowed,
  )

  return (
    <div className="flex min-h-screen flex-col">
      {/*
        First in the DOM and visible on focus. Without it a keyboard user
        tabs through every nav link on every page before reaching the content.
      */}
      <a
        href="#main"
        className="bg-background focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:ring-2"
      >
        Skip to content
      </a>

      <header className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Link
          href="/dashboard"
          className="focus-visible:ring-ring rounded-md text-sm font-semibold tracking-tight focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Rental Operations
        </Link>

        <PropertySwitcher scope={scope} onSelect={selectScope} />

        <form action="/search" className="ml-auto flex items-center gap-2">
          <label htmlFor="global-search" className="sr-only">
            Search
          </label>
          <input
            id="global-search"
            name="q"
            type="search"
            placeholder="Search"
            className="border-input bg-background focus-visible:ring-ring min-h-11 w-40 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:w-56"
          />
        </form>

        <Link
          href="/account"
          className="focus-visible:ring-ring text-muted-foreground hover:text-foreground rounded-md text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {actorName(await currentActor())}
        </Link>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        {/*
          Horizontally scrolling strip on a phone, sidebar from md up. The
          staff surfaces are desk-first but a PM checks them from a driveway
          (PRD §6.5), so the nav has to survive a narrow viewport.
        */}
        <aside className="border-border shrink-0 overflow-x-auto border-b p-3 md:w-56 md:border-r md:border-b-0">
          <Nav items={visibleItems} />
        </aside>

        <main id="main" className="flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}

function actorName(actor: Awaited<ReturnType<typeof currentActor>>) {
  return actor?.kind === 'staff' ? 'Your account' : 'Account'
}
