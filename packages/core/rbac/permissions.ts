// The permission vocabulary. Closed, and defined in code rather than in a
// database table, because code is what checks permissions - a permission key
// no `can()` call ever reads is a promise the product does not keep.
//
// Roles are still data (D-5): a Role row holds a set of these keys, so which
// permissions a role carries can change without a release. What cannot change
// without a release is the set of things the product knows how to check.

export const PERMISSIONS = [
  'property.read',
  'property.write',
  'unit.read',
  'unit.write',
  'lease.read',
  'lease.write',
  'tenant.read',
  'tenant.write',
  'ledger.read',
  'ledger.adjust',
  'payment.record',
  'fee.waive',
  'ticket.read',
  'ticket.write',
  'workorder.read',
  'workorder.write',
  'workorder.approve',
  'vendor.read',
  'vendor.write',
  'inspection.read',
  'inspection.write',
  'document.read',
  'document.write',
  'document.delete',
  'notice.read',
  'notice.send',
  'message.read',
  'message.send',
  'task.read',
  'task.write',
  'staff.read',
  'staff.manage',
  /// A vendor or tech seeing a lockbox code is a privileged read, and R-005
  /// logs every one of them (PROP-03).
  'accesscode.reveal',
  /// Handing a code to the TENANT at move-in (INSP-01, R-069) - its own
  /// permission rather than folded into `accesscode.reveal`, because a
  /// maintenance tech revealing a code for their own job and a manager
  /// releasing keys to a new tenant are different acts with different
  /// consequences if done at the wrong moment. `issueAccessCodeToTenant`
  /// gates this on the deposit having actually cleared.
  'accesscode.issue',
  'report.financial',
  'audit.read',
  /// Opening and running an eviction case (PAY-14, R-083). ITS OWN
  /// PERMISSION, not folded into `lease.write` or `notice.send`, because
  /// starting an eviction is the most consequential thing this product does
  /// to a person and it should be possible to hand somebody the leasing and
  /// notice-serving job without also handing them that. `notice.send` still
  /// gates the legally operative act - serving the notice itself - so the
  /// two are checked at different moments, deliberately.
  'eviction.manage',
  /// Portfolio-wide only (R-010): a JurisdictionRule applies by state, not by
  /// property or entity, so there is no scoped resource to check it against.
  /// `requirePermission('jurisdiction.write')` with no resource is the
  /// correct guard, not a bug - see propertyResource()'s own comment for the
  /// failure mode a resource-less check usually is.
  'jurisdiction.read',
  'jurisdiction.write',
  /// Managed message templates (COMM-03, R-049). Authoring one is portfolio-
  /// wide work, like a jurisdiction rule: a template is not owned by a
  /// property, and the same violation notice is sent from all of them.
  'template.write',
  /// APPROVING A TRANSLATION IS ITS OWN PERMISSION, and privileged.
  ///
  /// COMM-03's rule - attorney-approved translations for legal notices,
  /// machine translation for routine chat only - is enforced by a single
  /// `approvedAt` timestamp. If everybody who can write a template can also
  /// set that timestamp, the rule is decorative: the person who pasted a
  /// machine translation in marks their own work approved and a defective
  /// notice to vacate goes out in a language nobody with authority read.
  'template.approve',
  /// Recording a screening accept/decline (LEASE-04, R-060). Its own
  /// permission rather than folded into `lease.write` - audit/events.ts's
  /// header already named "screening decision" among the privileged
  /// actions ROLE-03 lists, ahead of this permission existing, and this is
  /// where that forward reference gets a permission to point at.
  'screening.decide',
  /// Generating a lease document and sending it for e-signature (LEASE-06,
  /// R-063) - its own permission rather than folded into `lease.write` for
  /// the same reason `screening.decide` is: this is the action that makes a
  /// legally binding document and, once every signer completes, moves the
  /// lease live and creates the deposit charge and rent subscription. Also
  /// covers voiding a sent-but-unsigned envelope.
  'lease.execute',
  /// Placing a lease hold, and lifting one whose type does not call for the
  /// permission below (RISK-11, RISK-12, R-084).
  'hold.manage',
  /// Lifting a hold where lifting is itself a legal judgement - SCRA,
  /// bankruptcy, deceased. Its own permission for the same reason
  /// `template.approve` is separate from `template.write`: the act being
  /// controlled is not "edit this record", it is "assert the protection no
  /// longer applies", and it is the one an eviction defence will ask about.
  /// PRIVILEGED, so it needs a proved second factor - resuming collection
  /// against a bankrupt or a deployed servicemember from a stolen session is
  /// the same class of harm as moving money.
  'hold.lift_protected',
  /// RISK-04 / ROLE-05 (R-091): reading a confidential safety case.
  ///
  /// THE ONLY PERMISSION IN THIS LIST SEEDED TO THE OWNER ROLE ALONE, which
  /// happens by construction rather than by a rule: `owner` carries
  /// `PERMISSIONS` entire and every other role names its own, so a new key
  /// is owner-only until somebody adds it to a role.
  ///
  /// A permission rather than a hard-coded `role === 'owner'` test, because
  /// of D-5: roles are data, so an owner who genuinely wants a trusted
  /// manager to carry this can grant it deliberately, without a release. A
  /// role check would look identical from the outside and make that
  /// impossible.
  ///
  /// It is a READ on this list at all, which is the exception to the rule
  /// PRIVILEGED_PERMISSIONS states below about reads never being privileged.
  /// It is not itself privileged - locking an owner out of a safety case
  /// because they have not finished setting up an authenticator is the wrong
  /// failure - but `confidential.manage` is.
  'confidential.read',
  /// Opening, updating and closing a confidential case, ordering its lock
  /// change, and retiring the access codes a restricted party may know.
  'confidential.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

/**
 * Actions ROLE-03 calls privileged, and therefore the ones ROLE-05 requires a
 * proved second factor for: "MFA required for staff before first privileged
 * action".
 *
 * This is where R-003's `mfaVerified` finally has teeth. Reading data is never
 * on this list - locking a manager out of the rent roll because they have not
 * set up an authenticator is how MFA gets disabled by an irritated owner.
 * Moving money, changing who can do what, destroying evidence and revealing
 * access codes are.
 */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'ledger.adjust',
  // R-049. Signing off a legal translation is a claim that somebody with
  // authority read it, and the product cannot verify that - it can only
  // record who said so. A stolen session making that claim is the same class
  // of harm as one moving money.
  'template.approve',
  'fee.waive',
  'workorder.approve',
  'staff.manage',
  'document.delete',
  'accesscode.reveal',
  'accesscode.issue',
  'screening.decide',
  'lease.execute',
  // R-084. Not `hold.manage` - placing a hold is the safe direction and
  // gating it behind MFA is how holds stop being placed. Taking one off a
  // protected tenancy is the direction that does harm.
  'hold.lift_protected',
  // R-091. See the permission's own comment: ordering a lock change and
  // retiring the codes a restricted party may know are acts somebody's
  // physical safety rests on, and neither should be reachable from a stolen
  // session. `confidential.read` is deliberately NOT here.
  'confidential.manage',
])

export function requiresMfa(permission: Permission): boolean {
  return PRIVILEGED_PERMISSIONS.has(permission)
}

/// The role keys the product depends on. `Role.key` uses these; nothing
/// refers to a role by name or id.
export const ROLE_KEYS = [
  'owner',
  'manager',
  'maintenance_tech',
  'read_only',
  'tenant',
  'guarantor',
] as const

export type RoleKey = (typeof ROLE_KEYS)[number]

/**
 * The seeded role definitions (ROLE-01). Seeded into the Role table by
 * packages/db/prisma/seed.mts, which is what makes them data - this constant
 * is the starting point, not the runtime source of truth. `can()` reads the
 * permissions carried on the actor's assignments, never this object.
 *
 * `owner` is spelled out as "every permission" rather than as a wildcard on
 * purpose. A wildcard is a superuser flag wearing a different hat, and D-5
 * forbids one: an owner is a role with a full permission list and a null
 * scope, so revoking one permission from it is an ordinary edit.
 */
export const ROLE_DEFINITIONS: Record<
  RoleKey,
  {
    name: string
    description: string
    permissions: readonly Permission[]
    defaultApproveWorkOrderCents: number | null
    defaultWaiveFeeCents: number | null
  }
> = {
  owner: {
    name: 'Owner',
    description:
      'Full access across every property. Unrestricted access is this role with a null scope - there is no superuser flag (D-5).',
    permissions: PERMISSIONS,
    // Null means "no ceiling configured", and for the owner role that is read
    // as unlimited by checkMonetaryAuthority - the owner IS the escalation
    // target, so there is nobody to route up to.
    defaultApproveWorkOrderCents: null,
    defaultWaiveFeeCents: null,
  },

  manager: {
    name: 'Manager',
    description:
      'Runs the portfolio day to day within configured monetary ceilings. Cannot change who has access, and cannot adjust the ledger.',
    permissions: [
      'property.read',
      'property.write',
      'unit.read',
      'unit.write',
      'lease.read',
      'lease.write',
      'screening.decide',
      'lease.execute',
      'tenant.read',
      'tenant.write',
      'ledger.read',
      'payment.record',
      'fee.waive',
      'ticket.read',
      'ticket.write',
      'workorder.read',
      'workorder.write',
      'workorder.approve',
      'vendor.read',
      'vendor.write',
      'inspection.read',
      'inspection.write',
      'document.read',
      'document.write',
      'notice.read',
      'notice.send',
      'message.read',
      'message.send',
      /// Authors templates, does NOT approve legal translations - the same
      /// split as jurisdiction read/write one line down, and for the same
      /// reason: signing off legal wording is not day-to-day portfolio work.
      'template.write',
      'task.read',
      'task.write',
      'staff.read',
      'accesscode.reveal',
      /// Releasing keys to a tenant is leasing/PM work, not a maintenance
      /// tech's job (they keep `accesscode.reveal` for their own jobs, not
      /// this).
      'accesscode.issue',
      'report.financial',
      /// Read, not write: a jurisdiction config change is a legal release
      /// gate (D-4), not day-to-day portfolio work.
      'jurisdiction.read',
      /// Running the eviction path is squarely a property manager's job
      /// (PAY-14, R-083) - they serve the notices and attend the hearing.
      'eviction.manage',
      /// R-084's "manager-or-above". Both are seeded to the manager because
      /// the manager IS the person who learns a tenant has died or filed;
      /// what makes the second one different is the MFA it carries, and that
      /// an owner can revoke it from the role without a release (D-5).
      'hold.manage',
      'hold.lift_protected',
    ],
    // ROLE-02's example boundary, in cents. Owner-configurable per user.
    defaultApproveWorkOrderCents: 50_000,
    defaultWaiveFeeCents: 10_000,
  },

  maintenance_tech: {
    name: 'Maintenance Tech',
    description:
      'Assigned jobs and the unit operating data needed to do them. No financials, no leases, no tenant records beyond contact for the job.',
    permissions: [
      'property.read',
      'unit.read',
      'ticket.read',
      'workorder.read',
      'workorder.write',
      'inspection.read',
      'inspection.write',
      'document.read',
      'document.write',
      'message.read',
      'message.send',
      'task.read',
      'task.write',
      'accesscode.reveal',
    ],
    defaultApproveWorkOrderCents: 0,
    defaultWaiveFeeCents: 0,
  },

  read_only: {
    name: 'Read-only / Partner',
    description:
      'Sees everything within scope and changes nothing. The bookkeeper and the investor partner both live here (ROLE-04).',
    permissions: [
      'property.read',
      'unit.read',
      'lease.read',
      'tenant.read',
      'ledger.read',
      'ticket.read',
      'workorder.read',
      'vendor.read',
      'inspection.read',
      'document.read',
      'notice.read',
      'message.read',
      'task.read',
      'report.financial',
      'jurisdiction.read',
    ],
    defaultApproveWorkOrderCents: 0,
    defaultWaiveFeeCents: 0,
  },

  tenant: {
    name: 'Tenant',
    description:
      'Their own lease, their own balance, their own maintenance requests and documents. Scope is the lease, never a property.',
    permissions: [
      'lease.read',
      'ledger.read',
      'ticket.read',
      'ticket.write',
      'document.read',
      'message.read',
      'message.send',
    ],
    defaultApproveWorkOrderCents: 0,
    defaultWaiveFeeCents: 0,
  },

  guarantor: {
    name: 'Guarantor',
    description:
      'Financial liability visibility only (LEASE-06). No maintenance, no messages, no documents beyond the lease they guaranteed.',
    permissions: ['lease.read', 'ledger.read'],
    defaultApproveWorkOrderCents: 0,
    defaultWaiveFeeCents: 0,
  },
}
