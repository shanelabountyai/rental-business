import 'server-only'

import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The seam where auth links leave the system.
//
// ==========================================================================
// THIS FILE WAS R-003's PLACEHOLDER FOR SEVENTEEN MONTHS AND NOBODY NOTICED
// (R-139).
//
// Its body was `if (NODE_ENV === 'production') { console.warn(…); return }`.
// Its own comment said "R-030 replaces this". R-030 built the notification
// engine; R-104 wired Resend and Twilio into it; neither touched this file.
// So on a deployed environment the tenant magic link was never sent - and it
// is the ONLY tenant provider wired in `auth.ts`, which means no tenant could
// sign in at all - and neither was a staff password reset.
//
// It survived because the vendor path, the one anybody watches, does not come
// through here: R-025 built its own `lib/vendors/link.ts` and dispatches
// through the engine. The dead `auth/vendor-link.ts` that did come through
// here was deleted with this item.
// ==========================================================================
//
// Every auth link now goes out as an `account_access` notification, which is
// what CLAUDE.md has always required of every other module ("no module
// hand-rolls its own sending"). Three properties of that category matter
// here and are set in packages/core/notifications/categories.ts:
//
//   LOCKED. A recipient cannot switch off the message that lets them sign in.
//   The explanation next to it says why, because they would also lose the
//   page they would need to turn it back on.
//
//   EMAIL only. PORTAL would deliver a sign-in link to a surface you must
//   already be signed in to read. SMS is not offered yet only because this
//   function has only ever taken one address.
//
//   NO PROPERTY, so quiet hours never defer it - `notify()`'s own rule, not
//   an exemption written here. A link that expires in fifteen minutes cannot
//   wait until 8am, and this is the one message where 3am is exactly when it
//   is wanted.

export type AuthLinkKind =
  | 'tenant_magic_link'
  | 'guarantor_magic_link'
  | 'staff_password_reset'
  | 'staff_setup_link'

const TEMPLATE_KEYS: Record<AuthLinkKind, string> = {
  tenant_magic_link: 'auth.tenant_magic_link',
  guarantor_magic_link: 'auth.guarantor_magic_link',
  staff_password_reset: 'auth.staff_password_reset',
  staff_setup_link: 'auth.staff_setup_link',
}

export interface AuthLinkDelivery {
  kind: AuthLinkKind
  /// Who it is for, in the engine's own terms. `id` makes the send auditable
  /// against a person rather than against an address, which is what lets
  /// "did we ever actually send them one" be answered from the delivery log.
  recipient: { type: 'STAFF' | 'TENANT' | 'GUARANTOR'; id: string; name: string }
  /// Email address or phone number, depending on the recipient's preference.
  /// R-030 resolves the channel; R-003 only knows who to hand it to.
  to: string
  url: string
  expiresAt: Date
  /// The AuthToken row this link came from. It is the idempotency key, and it
  /// has to be the TOKEN rather than the recipient: two resets minted for the
  /// same person are two genuinely different messages, and a key derived from
  /// the person would make the engine swallow the second as a duplicate - the
  /// one failure mode a sign-in link cannot afford.
  tokenId: string
  now?: Date
}

function expiresIn(expiresAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000))
  if (minutes < 90) return `${minutes} minutes`
  return `${Math.round(minutes / 60)} hours`
}

export async function deliverAuthLink(delivery: AuthLinkDelivery): Promise<void> {
  const now = delivery.now ?? new Date()

  // NOT wrapped in a try/catch, deliberately. A failure to RECORD is a real
  // failure, and seventeen months of a silent `console.warn` is the argument
  // against swallowing one - the neutral "if that address has an account…"
  // response every caller gives is about not confirming who has an account,
  // never about hiding that the product is broken.
  const outcomes = await notify({
    category: 'account_access',
    templateKey: TEMPLATE_KEYS[delivery.kind],
    recipient: {
      type: delivery.recipient.type,
      id: delivery.recipient.id,
      email: delivery.to,
    },
    context: {
      name: delivery.recipient.name,
      url: delivery.url,
      expiresIn: expiresIn(delivery.expiresAt, now),
    },
    // No property. See the header: this is what keeps quiet hours out of it.
    propertyId: null,
    idempotencyKey: `auth-link:${delivery.tokenId}`,
    now,
  })

  try {
    // Scoped to this one message. A person is standing at a login form, so
    // the send cannot wait for the hourly cron - and an unscoped sweep would
    // make them pay for the entire global queue and could send everything
    // EXCEPT the link they just asked for.
    await dispatchPendingNotifications(now, 10, {
      deliveryIds: outcomes
        .map((outcome) => outcome.deliveryId)
        .filter((id): id is string => id != null),
    })
  } catch (error) {
    // The row is already QUEUED and durable, so R-106's retry sweep owns it
    // from here. Failing the caller now would turn a provider blip into a
    // 500 on the login form for a message that is still going to arrive.
    console.error(`[auth] ${delivery.kind} recorded but not sent immediately`, error)
  }
}

/// Builds an absolute URL from AUTH_URL. Deliberately not derived from the
/// request's Host header: an attacker who can set Host could otherwise have a
/// password-reset link built against their own domain and mailed to the real
/// user.
export function authUrl(path: string): string {
  const base = process.env.AUTH_URL
  if (!base) {
    throw new Error('AUTH_URL is not set; auth links cannot be built.')
  }
  return new URL(path, base).toString()
}
