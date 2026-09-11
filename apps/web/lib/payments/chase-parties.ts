// Moved out of reminders.ts in R-199, which is `'use server'` and so may
// export only async functions - agreeing a payment plan sends its schedule to
// the same people the chase writes to, and a second copy of this list is one
// that eventually stops matching.

/// Everyone on this tenancy who can be chased for the money (R-179): every
/// ACTIVE tenant, plus every active guarantor.
///
/// A guarantor has no `preferredLocale` column — they are not a portal-first
/// party and nothing has ever asked them — so they get the template's default
/// language. Named here rather than left implicit, because a null falling
/// through `languageFor` silently is exactly how a Spanish-speaking
/// co-signer gets English forever without anybody noticing.
export function chaseParties(lease: {
  leaseTenants: { tenant: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null; preferredLocale: string | null; active: boolean } }[]
  guarantors: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null }[]
}): {
  type: 'TENANT' | 'GUARANTOR'
  id: string
  name: string
  email: string | null
  phone: string | null
  preferredLocale: string | null
}[] {
  return [
    ...lease.leaseTenants
      .map((lt) => lt.tenant)
      .filter((tenant) => tenant.active)
      .map((tenant) => ({
        type: 'TENANT' as const,
        id: tenant.id,
        name: `${tenant.firstName} ${tenant.lastName}`,
        email: tenant.email,
        phone: tenant.phone,
        preferredLocale: tenant.preferredLocale,
      })),
    ...lease.guarantors.map((guarantor) => ({
      type: 'GUARANTOR' as const,
      id: guarantor.id,
      name: `${guarantor.firstName} ${guarantor.lastName}`,
      email: guarantor.email,
      phone: guarantor.phone,
      preferredLocale: null,
    })),
  ]
}
