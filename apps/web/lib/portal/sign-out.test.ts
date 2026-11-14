import { beforeEach, describe, expect, it, vi } from 'vitest'

// K1 (INV-05): a renter's "Sign out" must revoke the session server-side, not
// only clear this browser's cookie. The watermark (`sessionsValidFrom`) is what
// the jwt callback compares against, so sign-out has to move it. No database:
// the claim is about WHICH row is bumped and that it happens before signOut.

const order: string[] = []
const session = vi.hoisted(() => ({ value: null as null | { principal: Record<string, unknown> } }))
const signOut = vi.hoisted(() => vi.fn(async (_: { redirectTo: string }) => {}))
const tenantUpdate = vi.hoisted(() => vi.fn(async (_: unknown) => ({ count: 1 })))
const guarantorUpdate = vi.hoisted(() => vi.fn(async (_: unknown) => ({ count: 1 })))

vi.mock('@/auth.ts', () => ({
  auth: async () => session.value,
  signOut: async (args: { redirectTo: string }) => {
    order.push('signOut')
    return signOut(args)
  },
}))
vi.mock('@rental/db', () => ({
  prisma: {
    tenant: {
      updateMany: async (args: unknown) => {
        order.push('tenant')
        return tenantUpdate(args)
      },
    },
    guarantor: {
      updateMany: async (args: unknown) => {
        order.push('guarantor')
        return guarantorUpdate(args)
      },
    },
  },
}))

const { signOutTenant, signOutGuarantor } = await import('./actions.ts')

const principal = (kind: string) => ({ id: `${kind}_1`, kind, orgId: 'org_x' })

beforeEach(() => {
  order.length = 0
  signOut.mockClear()
  tenantUpdate.mockClear()
  guarantorUpdate.mockClear()
})

describe('portal sign-out revokes the session (K1)', () => {
  it("a tenant's sign-out bumps their own watermark, scoped to their org, before signOut", async () => {
    session.value = { principal: principal('tenant') }
    const before = Date.now()
    await signOutTenant()

    expect(order).toEqual(['tenant', 'signOut'])
    const args = tenantUpdate.mock.calls[0]![0] as { where: unknown; data: { sessionsValidFrom: Date } }
    expect(args.where).toEqual({ id: 'tenant_1', orgId: 'org_x' })
    expect(args.data.sessionsValidFrom.getTime()).toBeGreaterThanOrEqual(before)
    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/portal/login' })
    expect(guarantorUpdate).not.toHaveBeenCalled()
  })

  it("a guarantor's sign-out bumps the Guarantor row, not a Tenant row", async () => {
    session.value = { principal: principal('guarantor') }
    await signOutGuarantor()

    expect(order).toEqual(['guarantor', 'signOut'])
    expect((guarantorUpdate.mock.calls[0]![0] as { where: unknown }).where).toEqual({
      id: 'guarantor_1',
      orgId: 'org_x',
    })
    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/portal/guarantor/login' })
    expect(tenantUpdate).not.toHaveBeenCalled()
  })

  it('with no session it still signs out and touches no row', async () => {
    session.value = null
    await signOutTenant()
    expect(order).toEqual(['signOut'])
  })

  it('never bumps a staff row from the portal action', async () => {
    session.value = { principal: principal('staff') }
    await signOutTenant()
    expect(order).toEqual(['signOut'])
  })
})
