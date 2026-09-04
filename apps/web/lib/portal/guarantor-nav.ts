import type { PortalNavItem } from './nav.ts'

// The guarantor portal's navigation (R-165). Two items, not the tenant
// portal's six - LEASE-06 is explicit that a guarantor gets no maintenance,
// no messages and no papers, and a nav item that goes nowhere useful is
// worse than no nav item.
export const GUARANTOR_NAV_ITEMS: readonly PortalNavItem[] = [
  { href: '/portal/guarantor', label: 'Balance', description: 'What you guarantee and your ledger' },
  {
    href: '/portal/guarantor/notices',
    label: 'Notices',
    description: 'Letters about the lease you guarantee',
  },
]
