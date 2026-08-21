import type { Permission } from '@rental/core/rbac'

// The navigation, as data. One list, so "which sections exist and who sees
// them" is answerable by reading a single array rather than by grepping JSX.
//
// Every entry names the permission that reveals it. Hiding a link is NOT
// authorization - ROLE-01 is explicit that enforcement is server-side per role
// and record scope, "not just hidden UI" - so each destination guards itself
// as well. The permission here exists so a maintenance tech is not shown a
// financial section that would refuse them anyway.

export interface NavItem {
  href: string
  label: string
  /// Shown only to an actor holding this permission somewhere in scope.
  permission: Permission
  /// Which backlog item fills the section in. Rendered on the placeholder, so
  /// a half-built shell explains itself instead of looking broken.
  ownedBy: string
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    permission: 'property.read',
    ownedBy: 'R-013',
  },
  {
    href: '/properties',
    label: 'Properties',
    permission: 'property.read',
    ownedBy: 'R-008',
  },
  {
    href: '/leases',
    label: 'Leases',
    permission: 'lease.read',
    // R-033, not R-016 - R-016 is the notification engine. Corrected while
    // building it, since the wrong item number here is how a later session
    // goes looking for lease work in the wrong place.
    ownedBy: 'R-033',
  },
  {
    href: '/maintenance',
    label: 'Maintenance',
    permission: 'ticket.read',
    ownedBy: 'R-022',
  },
  {
    href: '/workorders',
    label: 'Work orders',
    permission: 'workorder.read',
    ownedBy: 'R-024',
  },
  {
    href: '/money',
    label: 'Money',
    permission: 'ledger.read',
    ownedBy: 'R-035',
  },
  {
    href: '/tasks',
    label: 'Tasks',
    permission: 'task.read',
    ownedBy: 'R-011',
  },
  {
    href: '/notices',
    label: 'Notices',
    permission: 'notice.read',
    ownedBy: 'R-051',
  },
  {
    href: '/messages',
    label: 'Messages',
    permission: 'message.read',
    ownedBy: 'R-017',
  },
  {
    href: '/notifications',
    label: 'Notifications',
    permission: 'message.read',
    ownedBy: 'R-016',
  },
  {
    href: '/jurisdiction',
    label: 'Jurisdiction rules',
    permission: 'jurisdiction.read',
    ownedBy: 'R-010',
  },
  {
    href: '/prospects',
    label: 'Prospects',
    permission: 'lease.read',
    ownedBy: 'R-058',
  },
  {
    href: '/documents/templates',
    label: 'Document templates',
    permission: 'template.write',
    ownedBy: 'R-062',
  },
  {
    href: '/inspections',
    label: 'Inspections',
    permission: 'inspection.read',
    ownedBy: 'R-068',
  },
  {
    href: '/reports',
    label: 'Reports',
    permission: 'property.read',
    ownedBy: 'R-076',
  },
  {
    href: '/compliance',
    label: 'Compliance',
    permission: 'property.read',
    ownedBy: 'R-077',
  },
  {
    href: '/vendors',
    label: 'Vendors',
    permission: 'vendor.read',
    ownedBy: 'R-079',
  },
]
