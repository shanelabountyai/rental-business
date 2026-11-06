// R-296 (D-322): the platform's Connect application fee. Pure arithmetic, so
// the one-off charges that carry an `application_fee_amount` and the
// subscription's `application_fee_percent` agree on the same basis points.

/// The console's range (PRD 11 §4.6), also a CHECK on the column.
export const MAX_PLATFORM_FEE_BPS = 1000

/// The fee on `amountCents`, rounded half up to the cent the way Stripe
/// rounds a percentage fee. Never more than the amount.
export function platformFeeCents(amountCents: number, bps: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || bps <= 0) return 0
  return Math.min(amountCents, Math.round((amountCents * bps) / 10_000))
}

/// Stripe's `application_fee_percent` for `bps`: 250 → 2.5. Two decimals at
/// most, which is what Stripe accepts.
export function platformFeePercent(bps: number): number {
  return bps / 100
}

/// "2.5%" for a notice or the console.
export function formatPlatformFee(bps: number): string {
  return `${platformFeePercent(bps)}%`
}

/// Why the console refuses a typed value, or null. Whole basis points only.
export function platformFeeRefusal(raw: string): string | null {
  if (!/^\d{1,4}$/.test(raw)) return 'Enter whole basis points, from 0 to 1000.'
  return Number(raw) > MAX_PLATFORM_FEE_BPS ? 'The fee cannot be more than 1000 basis points (10%).' : null
}
