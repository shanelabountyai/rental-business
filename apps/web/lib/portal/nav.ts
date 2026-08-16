// The tenant portal's navigation, as data (R-018).
//
// Five items and no permissions: a tenant has one role and sees the same
// portal as every other tenant. Unlike the staff nav, nothing here is
// filtered - the scoping happens inside each page's queries, on the tenant's
// own records.
//
// D-10 governs the words. "Home", not "unit" or "property" or "door".
// "Papers", not "documents" or "records" - the concrete word for the thing
// people keep in a drawer, at a lower reading level than the abstraction.
// "Messages", not "communications" or "threads".

export interface PortalNavItem {
  href: string
  label: string
  /// Read out by screen readers in place of the visible label where the
  /// visible one is short enough to be ambiguous on its own.
  description: string
}

export const PORTAL_NAV_ITEMS: readonly PortalNavItem[] = [
  { href: '/portal', label: 'Home', description: 'Your home and recent updates' },
  // Second, not last. D-10's plainest word for the thing, and the item a
  // tenant opens the portal for most months - a payment screen buried behind
  // "Papers" is a payment screen people phone the office about instead.
  { href: '/portal/pay', label: 'Pay rent', description: 'See what you owe and pay it' },
  {
    href: '/portal/maintenance',
    label: 'Report a problem',
    description: 'Report a maintenance problem and see past requests',
  },
  { href: '/portal/papers', label: 'Papers', description: 'Your lease and other papers' },
  // Separate from Papers deliberately: a notice is something that needs
  // reading NOW, and burying it in the filing drawer alongside the lease is
  // how it goes unread. D-10's lexicon - "notices", never "service".
  { href: '/portal/notices', label: 'Notices', description: 'Letters about your home' },
  { href: '/portal/messages', label: 'Messages', description: 'Messages with your landlord' },
]
