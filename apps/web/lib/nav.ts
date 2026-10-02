import type { Permission } from '@rental/core/rbac'

// The navigation, as data. One list, so "which sections exist and who sees
// them" is answerable by reading a single array rather than by grepping JSX.
//
// Every entry names the permission that reveals it. Hiding a link is NOT
// authorization - ROLE-01 is explicit that enforcement is server-side per role
// and record scope, "not just hidden UI" - so each destination guards itself
// as well. The permission here exists so a maintenance tech is not shown a
// financial section that would refuse them anyway.

// UX-03: the section a nav item sits under in the shell. Order here is the
// render order of the headed groups, not alphabetical - "Daily" first
// because that is what gets checked constantly, "Admin" last because it is
// mostly portfolio-wide back-office work.
export const NAV_GROUPS = ['Daily', 'Money', 'Property', 'Compliance', 'Admin'] as const
export type NavGroup = (typeof NAV_GROUPS)[number]

export interface NavItem {
  href: string
  label: string
  group: NavGroup
  /// Shown to an actor who holds this permission over ANYTHING
  /// (`holdsAnywhere`), not one who holds it portfolio-wide. A manager scoped
  /// to one house still runs that house's leases and money, so hiding those
  /// links from them was never right - it was R-123's bug.
  permission: Permission
  /// A destination that is portfolio-wide by nature and guards itself with a
  /// RESOURCE-LESS `requirePermission` - which `permissions.ts` calls "the
  /// correct guard, not a bug" for `jurisdiction.write`, because a
  /// JurisdictionRule applies by state and has no scoped resource to check
  /// against. A scoped actor cannot pass that guard, so showing them the link
  /// would only dead-end. These three are checked with `can()` and no
  /// resource, which is precisely "holds it portfolio-wide".
  ///
  /// Whether a property-scoped manager SHOULD reach the vendor directory is a
  /// real operational question - a PM who cannot see vendors cannot dispatch
  /// one - and it is a permissions decision, deliberately not made here
  /// (R-123).
  portfolioOnly?: true
  /// Which backlog item fills the section in. Rendered on the placeholder, so
  /// a half-built shell explains itself instead of looking broken.
  ownedBy: string
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    group: 'Daily',
    permission: 'property.read',
    ownedBy: 'R-013',
  },
  {
    href: '/properties',
    label: 'Properties',
    group: 'Property',
    permission: 'property.read',
    ownedBy: 'R-008',
  },
  {
    href: '/leases',
    label: 'Leases',
    group: 'Property',
    permission: 'lease.read',
    // R-033, not R-016 - R-016 is the notification engine. Corrected while
    // building it, since the wrong item number here is how a later session
    // goes looking for lease work in the wrong place.
    ownedBy: 'R-033',
  },
  {
    href: '/maintenance',
    label: 'Maintenance',
    group: 'Daily',
    permission: 'ticket.read',
    ownedBy: 'R-022',
  },
  {
    href: '/confidential',
    label: 'Confidential',
    group: 'Property',
    // RISK-04 / ROLE-05 (R-091). Seeded to the Owner role alone, so this link
    // simply is not there for anybody else - not greyed out, not present with
    // a tooltip. A nav entry a manager can see but not open would announce
    // that the product holds restricted records, which is most of what the
    // access control is for.
    permission: 'confidential.read',
    ownedBy: 'R-091',
  },
  {
    href: '/workorders',
    label: 'Work orders',
    group: 'Daily',
    permission: 'workorder.read',
    ownedBy: 'R-024',
  },
  {
    href: '/money',
    label: 'Money',
    group: 'Money',
    permission: 'ledger.read',
    ownedBy: 'R-035',
  },
  {
    href: '/tasks',
    label: 'Tasks',
    group: 'Daily',
    permission: 'task.read',
    ownedBy: 'R-011',
  },
  {
    href: '/notices',
    label: 'Notices',
    group: 'Compliance',
    permission: 'notice.read',
    ownedBy: 'R-051',
  },
  {
    href: '/messages',
    label: 'Messages',
    group: 'Daily',
    permission: 'message.read',
    ownedBy: 'R-017',
  },
  {
    href: '/notifications',
    label: 'Notifications',
    group: 'Daily',
    permission: 'message.read',
    ownedBy: 'R-016',
  },
  {
    href: '/jurisdiction',
    label: 'Jurisdiction rules',
    group: 'Compliance',
    permission: 'jurisdiction.read',
    portfolioOnly: true,
    ownedBy: 'R-010',
  },
  {
    href: '/screening-criteria',
    label: 'Screening criteria',
    group: 'Compliance',
    permission: 'screening.criteria.read',
    portfolioOnly: true,
    ownedBy: 'R-242',
  },
  {
    href: '/jobs',
    label: 'Scheduled jobs',
    group: 'Admin',
    permission: 'job.manage',
    portfolioOnly: true,
    ownedBy: 'R-174',
  },
  {
    href: '/prospects',
    label: 'Prospects',
    group: 'Property',
    permission: 'lease.read',
    ownedBy: 'R-058',
  },
  {
    href: '/documents/templates',
    label: 'Document templates',
    group: 'Admin',
    permission: 'template.write',
    portfolioOnly: true,
    ownedBy: 'R-062',
  },
  {
    href: '/inspections',
    label: 'Inspections',
    group: 'Property',
    permission: 'inspection.read',
    ownedBy: 'R-068',
  },
  {
    href: '/reports',
    label: 'Reports',
    group: 'Property',
    permission: 'property.read',
    ownedBy: 'R-076',
  },
  {
    href: '/compliance',
    label: 'Compliance',
    group: 'Compliance',
    permission: 'property.read',
    ownedBy: 'R-077',
  },
  {
    href: '/vendors',
    label: 'Vendors',
    group: 'Admin',
    permission: 'vendor.read',
    portfolioOnly: true,
    ownedBy: 'R-079',
  },
  {
    href: '/maintenance/preventive',
    label: 'Preventive maintenance',
    group: 'Property',
    permission: 'workorder.read',
    ownedBy: 'R-080',
  },
  {
    href: '/evictions',
    label: 'Evictions',
    group: 'Compliance',
    permission: 'eviction.manage',
    ownedBy: 'R-083',
  },
  {
    href: '/abandonment',
    label: 'Gone dark',
    group: 'Compliance',
    /// Deliberately NOT "Abandonment" in the nav. A case is opened on a
    /// suspicion and the commonest outcome is the tenant coming back, so a
    /// menu item that already calls it abandonment prejudges every one of
    /// them - and it is the word that ends up quoted back in a
    /// self-help-eviction claim.
    permission: 'eviction.manage',
    ownedBy: 'R-087',
  },
  {
    href: '/claims',
    label: 'Claims',
    group: 'Compliance',
    /// Property-level, so the property permission. Not `report.financial`:
    /// the money here never touches the tenant ledger, and the people who
    /// need to see a live water claim are the ones who manage the building.
    permission: 'property.read',
    ownedBy: 'R-089',
  },
  {
    href: '/violations',
    label: 'Violations',
    group: 'Compliance',
    /// `lease.read`, not `eviction.manage`. Most of what happens here ends
    /// with the tenant keeping their home - the commonest outcome of finding
    /// an unauthorized occupant is that they apply and stay - and a leasing
    /// person who cannot see the register records nothing. Escalating to
    /// eviction is the one act behind the eviction permission.
    permission: 'lease.read',
    ownedBy: 'R-088',
  },
  {
    href: '/import',
    label: 'Import',
    group: 'Admin',
    /// `property.write` with no resource is the same portfolio-wide-only
    /// guard `createLegalEntity` already uses - onboarding a portfolio is
    /// not a thing a property- or entity-scoped manager does.
    permission: 'property.write',
    portfolioOnly: true,
    ownedBy: 'R-168',
  },
  {
    href: '/staff',
    label: 'Staff',
    group: 'Admin',
    /// `staff.read`, which the manager holds - the directory is readable by
    /// the people who work alongside it. Changing access needs
    /// `staff.manage`, which only the owner holds, and the page hides those
    /// controls rather than offering ones that would refuse.
    permission: 'staff.read',
    /// A StaffUser carries no `propertyId`, so there is no scoped resource to
    /// check against and the page guards itself resource-lessly - the same
    /// posture Vendors and Jurisdiction rules take. A property-scoped manager
    /// cannot pass that guard, so showing them the link would only dead-end.
    portfolioOnly: true,
    ownedBy: 'R-138',
  },
]
