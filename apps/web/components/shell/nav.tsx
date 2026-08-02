'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { NavItem } from '@/lib/nav.ts'

// The sections this actor can see, already filtered on the server. This
// component never decides visibility - it is handed the list.

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
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          // Prefix match so /properties/abc still highlights Properties.
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                // aria-current is what tells a screen reader which section it
                // is in; the colour change alone says nothing to anyone who
                // cannot see it.
                aria-current={active ? 'page' : undefined}
                className={`focus-visible:ring-ring flex min-h-11 items-center rounded-md px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
