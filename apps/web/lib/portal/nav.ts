// The tenant portal's navigation, as data (R-018).
//
// Three items and no permissions: a tenant has one role and sees the same
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
  { href: '/portal/papers', label: 'Papers', description: 'Your lease and other papers' },
  { href: '/portal/messages', label: 'Messages', description: 'Messages with your landlord' },
]
