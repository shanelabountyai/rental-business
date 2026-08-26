'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { SCOPE_COOKIE } from './current-scope.ts'

/**
 * Stores the property-switcher selection.
 *
 * Deliberately does no validation: the cookie is a preference, not a
 * permission, and `currentScope` intersects whatever it says with what R-004
 * allows on every request. Validating here as well would imply the value is
 * trusted somewhere, which is exactly the belief that turns a filter into a
 * privilege-escalation path.
 *
 * TAKES `FormData`, NOT A STRING (R-115). The switcher is a real
 * `<form action>` submitted by a real button, so it works on the first paint
 * of every admin page rather than only after React has hydrated the header -
 * and a server action reached that way is handed the form, not an argument.
 * `revalidatePath` is what `router.refresh()` used to do from the client: the
 * selection changes what every scoped query on the page below returns, so the
 * whole tree has to re-render, not just this control.
 */
export async function selectScope(formData: FormData): Promise<void> {
  const value = String(formData.get('scope') ?? 'all')
  const cookieStore = await cookies()
  cookieStore.set(SCOPE_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  })
  revalidatePath('/', 'layout')
}
