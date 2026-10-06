'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { PortalNavItem } from '@/lib/portal/nav.ts'

// A bottom bar on a phone, a normal row on a larger screen.
//
// Bottom placement on mobile is not decoration: the portal is used one-handed
// on a phone, and the top of a modern handset is out of thumb reach. D-8
// chose a PWA precisely so this behaves like an app, and an app puts its
// primary navigation where the thumb already is.
//
// Every target is at least 44px (§6.4), and the active item is marked with
// aria-current AND a weight change AND a bar - never colour alone, which
// §6.4 also rules out.
export function PortalNav({ items }: { items: readonly PortalNavItem[] }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Sections"
      className="border-border bg-background fixed inset-x-0 bottom-0 z-40 border-t sm:static sm:border-t-0 sm:border-b"
    >
      <ul className="mx-auto flex w-full max-w-2xl gap-x-1.5">
        {items.map((item) => {
          // Exact match for the portal root, prefix for the rest - otherwise
          // /portal would light up on every page.
          const active =
            item.href === '/portal'
              ? pathname === '/portal'
              : pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`focus-visible:ring-ring flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 border-t-2 px-1 py-2 text-center text-[11px] leading-tight focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:min-h-12 sm:border-t-0 sm:border-b-2 sm:px-1 sm:text-sm ${
                  active
                    ? 'border-foreground text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                {/*
                  A bare text node inside a `flex-col` Link becomes an
                  anonymous flex item, and an anonymous flex item still gets
                  `min-width: auto` - `min-w-0` on the Link itself can't
                  reach it. Wrapping the label gives an element to target,
                  but `items-center` sizes a flex item's cross axis to its
                  own fit-content by default, which paints wider than the
                  40px-ish column at 320px/7 items and bleeds into the next
                  one - `w-full` is what actually clamps it back to the
                  column's width (same `min-w-0`/cap pairing as the
                  `<select>` case in ui-classes.ts).
                */}
                <span className="w-full min-w-0 break-words">{item.label}</span>
                <span className="sr-only">. {item.description}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
