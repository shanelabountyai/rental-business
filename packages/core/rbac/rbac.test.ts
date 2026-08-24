import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkMonetaryAuthority, effectiveCeiling } from './authority.ts'
import {
  type Actor,
  type Assignment,
  can,
  propertyScope,
  scopeIsEmpty,
} from './can.ts'
import {
  PERMISSIONS,
  PRIVILEGED_PERMISSIONS,
  ROLE_DEFINITIONS,
  type Permission,
} from './permissions.ts'

const PROPERTY_A = 'prop_a'
const PROPERTY_B = 'prop_b'
const ENTITY_1 = 'entity_1'
const ENTITY_2 = 'entity_2'

function assignment(
  roleKey: keyof typeof ROLE_DEFINITIONS,
  scope: { legalEntityId?: string; propertyId?: string } = {},
): Assignment {
  return {
    roleKey,
    permissions: ROLE_DEFINITIONS[roleKey].permissions,
    legalEntityId: scope.legalEntityId ?? null,
    propertyId: scope.propertyId ?? null,
  }
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'staff_1',
    kind: 'staff',
    active: true,
    mfaVerified: true,
    assignments: [],
    leaseIds: [],
    ceilings: { approveWorkOrderCents: null, waiveFeeCents: null },
    ...overrides,
  }
}

describe('can — deny by default', () => {
  it('denies an actor with no assignments at all', () => {
    expect(can(actor(), 'property.read', { propertyId: PROPERTY_A })).toEqual({
      allowed: false,
      reason: 'no_permission',
    })
  })

  it('denies a deactivated actor everything, whatever their role says', () => {
    const owner = actor({
      active: false,
      assignments: [assignment('owner')],
    })
    // ROLE-06: deactivation kills access. The owner role is not an exception,
    // because there is nothing in can() that knows the word "owner".
    for (const permission of PERMISSIONS) {
      expect(can(owner, permission, { propertyId: PROPERTY_A })).toEqual({
        allowed: false,
        reason: 'inactive',
      })
    }
  })

  it('reports no_permission before out_of_scope', () => {
    // A tech has no ledger.adjust anywhere, so telling them they are out of
    // scope would send them chasing an access request that would not help.
    const tech = actor({
      assignments: [assignment('maintenance_tech', { propertyId: PROPERTY_A })],
    })
    expect(can(tech, 'ledger.adjust', { propertyId: PROPERTY_A })).toEqual({
      allowed: false,
      reason: 'no_permission',
    })
  })
})

describe('can — property and legal-entity scope (ROLE-04)', () => {
  it('allows a portfolio-wide assignment anywhere', () => {
    const owner = actor({ assignments: [assignment('owner')] })
    expect(can(owner, 'property.write', { propertyId: PROPERTY_A }).allowed).toBe(
      true,
    )
    expect(can(owner, 'property.write', { propertyId: PROPERTY_B }).allowed).toBe(
      true,
    )
  })

  it('confines a property-scoped assignment to that property', () => {
    const manager = actor({
      assignments: [assignment('manager', { propertyId: PROPERTY_A })],
    })
    expect(can(manager, 'lease.write', { propertyId: PROPERTY_A }).allowed).toBe(
      true,
    )
    expect(can(manager, 'lease.write', { propertyId: PROPERTY_B })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    })
  })

  it('confines an entity-scoped assignment to that entity', () => {
    const partner = actor({
      assignments: [assignment('read_only', { legalEntityId: ENTITY_1 })],
    })
    expect(
      can(partner, 'ledger.read', { legalEntityId: ENTITY_1 }).allowed,
    ).toBe(true)
    expect(can(partner, 'ledger.read', { legalEntityId: ENTITY_2 })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    })
  })

  // The failure mode this guards against: a check that passes because the
  // caller simply forgot to say what it was acting on.
  it('denies a scoped assignment when the resource names nothing', () => {
    const manager = actor({
      assignments: [assignment('manager', { propertyId: PROPERTY_A })],
    })
    expect(can(manager, 'lease.write', {})).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    })
  })

  it('unions several assignments', () => {
    const roving = actor({
      assignments: [
        assignment('manager', { propertyId: PROPERTY_A }),
        assignment('read_only', { propertyId: PROPERTY_B }),
      ],
    })
    expect(can(roving, 'lease.write', { propertyId: PROPERTY_A }).allowed).toBe(
      true,
    )
    // read_only grants lease.read at B but not lease.write.
    expect(can(roving, 'lease.write', { propertyId: PROPERTY_B }).allowed).toBe(
      false,
    )
    expect(can(roving, 'lease.read', { propertyId: PROPERTY_B }).allowed).toBe(
      true,
    )
  })
})

describe('can — MFA gate (ROLE-05)', () => {
  const unverifiedOwner = actor({
    mfaVerified: false,
    assignments: [assignment('owner')],
  })

  it('blocks every privileged permission without a proved second factor', () => {
    for (const permission of PRIVILEGED_PERMISSIONS) {
      expect(can(unverifiedOwner, permission, { propertyId: PROPERTY_A })).toEqual(
        { allowed: false, reason: 'mfa_required' },
      )
    }
  })

  // Locking someone out of the rent roll for not having set up an
  // authenticator is how MFA gets switched off by an irritated owner.
  it('leaves ordinary reads and writes alone', () => {
    expect(
      can(unverifiedOwner, 'property.read', { propertyId: PROPERTY_A }).allowed,
    ).toBe(true)
    expect(
      can(unverifiedOwner, 'ledger.read', { propertyId: PROPERTY_A }).allowed,
    ).toBe(true)
    expect(
      can(unverifiedOwner, 'lease.write', { propertyId: PROPERTY_A }).allowed,
    ).toBe(true)
  })

  it('lets the same actor through once MFA is verified', () => {
    const verified = actor({ assignments: [assignment('owner')] })
    for (const permission of PRIVILEGED_PERMISSIONS) {
      expect(can(verified, permission, { propertyId: PROPERTY_A }).allowed).toBe(
        true,
      )
    }
  })

  it('covers the actions ROLE-03 calls privileged', () => {
    expect([...PRIVILEGED_PERMISSIONS].sort()).toEqual([
      // R-069. Releasing a code to a tenant at move-in, gated on move-in
      // funds actually clearing.
      'accesscode.issue',
      'accesscode.reveal',
      // R-091 (RISK-04). Ordering the lock change on a safety case and
      // retiring the codes a restricted party may know are acts somebody's
      // physical safety rests on. `confidential.read` is NOT here - locking
      // an owner out of a safety case because they have not finished setting
      // up an authenticator is the wrong failure.
      'confidential.manage',
      'document.delete',
      'fee.waive',
      // R-084. Taking a hold off a protected tenancy — SCRA, a bankruptcy
      // stay, a dead tenant — resumes collection, fees and access against
      // somebody the law protects. Placing one is NOT here: gating the safe
      // direction behind MFA is how holds stop being placed.
      'hold.lift_protected',
      // R-063. Generating a lease and sending it for e-signature makes a
      // legally binding document, and completion moves the lease live and
      // creates the deposit charge and rent subscription.
      'lease.execute',
      'ledger.adjust',
      // R-060. A screening accept/decline is a fair-housing-sensitive
      // judgement, the same class of harm a stolen session moving money is.
      'screening.decide',
      'staff.manage',
      // R-049. Signing off a legal translation is a claim that somebody with
      // authority read it; the product can only record who said so, so the
      // claim itself is protected like moving money is.
      'template.approve',
      'workorder.approve',
    ])
  })
})

describe('can — tenants and guarantors are scoped to their lease', () => {
  const tenant = actor({
    id: 'tenant_1',
    kind: 'tenant',
    assignments: [assignment('tenant')],
    leaseIds: ['lease_1'],
  })

  it('allows a tenant their own lease', () => {
    expect(can(tenant, 'ledger.read', { leaseId: 'lease_1' }).allowed).toBe(true)
  })

  it("refuses another tenant's lease", () => {
    expect(can(tenant, 'ledger.read', { leaseId: 'lease_2' })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    })
  })

  // "own lease/tickets/docs/payments only" - a tenant has no property-level
  // access even to the property their own home sits on.
  it('gives a tenant no property-level access', () => {
    expect(can(tenant, 'ledger.read', { propertyId: PROPERTY_A })).toEqual({
      allowed: false,
      reason: 'out_of_scope',
    })
  })

  it('limits a guarantor to financial visibility (LEASE-06)', () => {
    const guarantor = actor({
      kind: 'guarantor',
      assignments: [assignment('guarantor')],
      leaseIds: ['lease_1'],
    })
    expect(can(guarantor, 'ledger.read', { leaseId: 'lease_1' }).allowed).toBe(
      true,
    )
    // No maintenance, no messages.
    expect(can(guarantor, 'ticket.write', { leaseId: 'lease_1' }).allowed).toBe(
      false,
    )
    expect(can(guarantor, 'message.send', { leaseId: 'lease_1' }).allowed).toBe(
      false,
    )
  })
})

describe('propertyScope', () => {
  it('reports portfolio-wide access for a null scope', () => {
    const owner = actor({ assignments: [assignment('owner')] })
    expect(propertyScope(owner, 'property.read')).toEqual({ everything: true })
  })

  it('collects the specific properties and entities otherwise', () => {
    const staff = actor({
      assignments: [
        assignment('manager', { propertyId: PROPERTY_A }),
        assignment('read_only', { legalEntityId: ENTITY_1 }),
      ],
    })
    const scope = propertyScope(staff, 'property.read')
    expect(scope).toEqual({
      everything: false,
      legalEntityIds: [ENTITY_1],
      propertyIds: [PROPERTY_A],
    })
  })

  it('narrows to only the assignments carrying that permission', () => {
    const staff = actor({
      assignments: [
        assignment('manager', { propertyId: PROPERTY_A }),
        assignment('read_only', { propertyId: PROPERTY_B }),
      ],
    })
    // Both roles can read; only manager can write.
    expect(propertyScope(staff, 'property.read')).toMatchObject({
      propertyIds: expect.arrayContaining([PROPERTY_A, PROPERTY_B]),
    })
    expect(propertyScope(staff, 'property.write')).toEqual({
      everything: false,
      legalEntityIds: [],
      propertyIds: [PROPERTY_A],
    })
  })

  it('returns an empty scope for a deactivated actor', () => {
    const owner = actor({ active: false, assignments: [assignment('owner')] })
    expect(scopeIsEmpty(propertyScope(owner, 'property.read'))).toBe(true)
  })

  // Otherwise an un-enrolled owner would get `everything: true` for a
  // privileged permission and a list query would hand back the whole
  // portfolio's worth of rows that can() would have refused one at a time.
  it('returns an empty scope for a privileged permission without MFA', () => {
    const owner = actor({
      mfaVerified: false,
      assignments: [assignment('owner')],
    })
    expect(scopeIsEmpty(propertyScope(owner, 'ledger.adjust'))).toBe(true)
    expect(propertyScope(owner, 'ledger.read')).toEqual({ everything: true })
  })

  it('agrees with can() for every permission and both scope shapes', () => {
    const staff = actor({
      assignments: [assignment('manager', { propertyId: PROPERTY_A })],
    })
    for (const permission of PERMISSIONS) {
      const scope = propertyScope(staff, permission)
      const single = can(staff, permission, { propertyId: PROPERTY_A }).allowed
      const reachable =
        scope.everything || scope.propertyIds.includes(PROPERTY_A)
      expect(reachable).toBe(single)
    }
  })

  it('gives a tenant no property scope at all', () => {
    const tenant = actor({
      kind: 'tenant',
      assignments: [assignment('tenant')],
      leaseIds: ['lease_1'],
    })
    expect(scopeIsEmpty(propertyScope(tenant, 'ledger.read'))).toBe(true)
  })
})

describe('checkMonetaryAuthority (ROLE-02, MAINT-04)', () => {
  const manager = (ceiling: number | null) =>
    actor({
      assignments: [assignment('manager', { propertyId: PROPERTY_A })],
      ceilings: { approveWorkOrderCents: ceiling, waiveFeeCents: ceiling },
    })

  it('allows an amount at or under the ceiling', () => {
    expect(
      checkMonetaryAuthority(manager(50_000), 'approve_work_order', 30_000),
    ).toEqual({ outcome: 'allowed' })
    expect(
      checkMonetaryAuthority(manager(50_000), 'approve_work_order', 50_000),
    ).toEqual({ outcome: 'allowed' })
  })

  // MAINT-04's exact example: a $650 estimate against a $500 ceiling enters
  // Pending Approval. It ROUTES UP - it does not fail.
  it('escalates over the ceiling rather than refusing', () => {
    expect(
      checkMonetaryAuthority(manager(50_000), 'approve_work_order', 65_000),
    ).toEqual({
      outcome: 'escalate',
      ceilingCents: 50_000,
      requestedCents: 65_000,
    })
  })

  it('denies outright at a zero ceiling instead of escalating', () => {
    // A tech opening a work order should not generate an approval request to
    // the owner every single time.
    expect(
      checkMonetaryAuthority(manager(0), 'approve_work_order', 1),
    ).toEqual({ outcome: 'denied', reason: 'no_authority' })
  })

  it('treats a null ceiling as unlimited, which is how the owner works', () => {
    expect(
      checkMonetaryAuthority(manager(null), 'approve_work_order', 9_999_999),
    ).toEqual({ outcome: 'allowed' })
  })

  it('denies a deactivated actor', () => {
    const gone = actor({
      active: false,
      ceilings: { approveWorkOrderCents: null, waiveFeeCents: null },
    })
    expect(checkMonetaryAuthority(gone, 'approve_work_order', 100)).toEqual({
      outcome: 'denied',
      reason: 'inactive',
    })
  })

  it.each([
    ['negative', -1],
    ['fractional cents', 10.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s amount', (_label, amount) => {
    expect(
      checkMonetaryAuthority(manager(50_000), 'approve_work_order', amount),
    ).toEqual({ outcome: 'denied', reason: 'invalid_amount' })
  })

  it('keeps the two ceilings independent', () => {
    const split = actor({
      ceilings: { approveWorkOrderCents: 50_000, waiveFeeCents: 0 },
    })
    expect(
      checkMonetaryAuthority(split, 'approve_work_order', 40_000),
    ).toEqual({ outcome: 'allowed' })
    expect(checkMonetaryAuthority(split, 'waive_fee', 1)).toEqual({
      outcome: 'denied',
      reason: 'no_authority',
    })
  })
})

describe('effectiveCeiling', () => {
  it('prefers a personal override over the role default', () => {
    expect(effectiveCeiling(30_000, [50_000])).toBe(30_000)
  })

  // The `||` bug: zero is a real override meaning "may approve nothing", and
  // treating it as absent would silently restore the role's default.
  it('honours a personal override of zero', () => {
    expect(effectiveCeiling(0, [50_000])).toBe(0)
  })

  it('falls back to the role default when there is no override', () => {
    expect(effectiveCeiling(null, [50_000])).toBe(50_000)
    expect(effectiveCeiling(undefined, [50_000])).toBe(50_000)
  })

  it('takes the most generous of several roles', () => {
    expect(effectiveCeiling(null, [10_000, 50_000, 0])).toBe(50_000)
  })

  it('lets an unlimited role win outright', () => {
    expect(effectiveCeiling(null, [10_000, null])).toBeNull()
  })

  it('grants nothing when there are no roles', () => {
    expect(effectiveCeiling(null, [])).toBe(0)
  })
})

describe('role definitions', () => {
  it('only uses permissions the code knows how to check', () => {
    for (const [key, role] of Object.entries(ROLE_DEFINITIONS)) {
      for (const permission of role.permissions) {
        expect(
          PERMISSIONS,
          `role ${key} references unknown permission ${permission}`,
        ).toContain(permission)
      }
    }
  })

  it('gives the owner every permission, spelled out rather than wildcarded', () => {
    expect([...ROLE_DEFINITIONS.owner.permissions].sort()).toEqual(
      [...PERMISSIONS].sort(),
    )
  })

  it('keeps ledger adjustment and access management away from managers', () => {
    const manager: readonly Permission[] = ROLE_DEFINITIONS.manager.permissions
    expect(manager).not.toContain('ledger.adjust')
    expect(manager).not.toContain('staff.manage')
    expect(manager).not.toContain('document.delete')
  })

  it('keeps financial data away from the maintenance tech', () => {
    const tech: readonly Permission[] =
      ROLE_DEFINITIONS.maintenance_tech.permissions
    for (const forbidden of [
      'ledger.read',
      'ledger.adjust',
      'lease.read',
      'report.financial',
      'payment.record',
    ] as const) {
      expect(tech).not.toContain(forbidden)
    }
  })

  it('lets the read-only role change nothing', () => {
    for (const permission of ROLE_DEFINITIONS.read_only.permissions) {
      expect(permission).toMatch(/\.read$|^report\./)
    }
  })

  it('gives every non-owner role an explicit ceiling rather than a blank one', () => {
    for (const [key, role] of Object.entries(ROLE_DEFINITIONS)) {
      if (key === 'owner') continue
      expect(role.defaultApproveWorkOrderCents).not.toBeNull()
      expect(role.defaultWaiveFeeCents).not.toBeNull()
    }
  })
})

// D-5 is a rule about code that no unit test can express by calling the
// functions - a bypass would make the tests above pass, not fail. So this
// reads the source and looks for one.
describe('D-5 — no superuser', () => {
  const sources = ['./can.ts', './authority.ts'].map((file) =>
    readFileSync(new URL(file, import.meta.url), 'utf8'),
  )

  it('never branches on a role name inside a decision function', () => {
    for (const source of sources) {
      const code = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
      // can() and checkMonetaryAuthority() must reach their verdict from
      // permissions and scope alone. Comparing against 'owner' anywhere in
      // here is the flag D-5 forbids, wearing a different hat.
      expect(code).not.toMatch(/roleKey\s*===/)
      expect(code).not.toMatch(/['"]owner['"]/)
      expect(code).not.toMatch(/isSuperuser|isAdmin|isOwner/i)
    }
  })
})
