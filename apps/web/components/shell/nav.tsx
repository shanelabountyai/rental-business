'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_GROUPS, type NavItem } from '@/lib/nav.ts'

// The sections this actor can see, already filtered on the server. This
// component never decides visibility - it is handed the list.
//
// UX-03: headed by NAV_GROUPS so Money, Tasks and Notices no longer sit in
// one undifferentiated list beside Jurisdiction rules and Import. A group
// with nothing visible in it (every item inside filtered out for this
// actor) renders no heading - an empty "Admin" heading would be its own
// small lie.

export function Nav({
  items,
  onNavigate,
}: {
  items: readonly NavItem[]
  onNavigate?: () => void
}) {
  const pathname = usePathname()

  return (
    <nav aria-label="Sections">
      <div className="flex flex-col gap-4">
        {NAV_GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.group === group)
          if (groupItems.length === 0) return null
          return (
            <div key={group}>
              <h2 className="text-muted-foreground px-3 text-xs font-semibold tracking-wide uppercase">
                {group}
              </h2>
              <ul className="flex flex-col gap-1">
                {groupItems.map((item) => {
                  // Prefix match so /properties/abc still highlights Properties.
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`)
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        // aria-current is what tells a screen reader which
                        // section it is in; the colour change alone says
                        // nothing to anyone who cannot see it.
                        aria-current={active ? 'page' : undefined}
                        className={`focus-visible:ring-ring flex min-h-11 items-center rounded-md px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
                          active
                            ? 'bg-secondary text-secondary-foreground font-medium'
                            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
