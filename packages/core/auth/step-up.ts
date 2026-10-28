// Step-up, or "fresh MFA" (PRD 11 §2.4, R-294c). The two decisions any
// catalogue's guard needs, free of sessions and cookies so the org side can
// reuse them for the owner's export and freeze (R-299, R-300): has a code been
// proved recently enough, and where may the step-up page send the user back.

export const STEP_UP_WINDOW_MS = 10 * 60_000

/// True when a second factor was proved within the window. A missing or
/// future timestamp is not fresh: a clock that disagrees is no proof.
export function stepUpIsFresh(
  mfaVerifiedAt: number | null | undefined,
  now = Date.now(),
  windowMs = STEP_UP_WINDOW_MS,
): boolean {
  if (!mfaVerifiedAt || mfaVerifiedAt > now) return false
  return now - mfaVerifiedAt <= windowMs
}

/// The page to return to after a step-up, or `fallback`. Only a same-origin
/// path under `prefix`: `next` is in the URL, so anything else is an open
/// redirect (`//evil.example`, `/\evil.example`, `https://…`).
export function stepUpReturnPath(next: unknown, prefix: string, fallback = prefix): string {
  if (typeof next !== 'string' || !next.startsWith('/') || /^\/[/\\]/.test(next)) return fallback
  if (/[\s\\]/.test(next)) return fallback
  const path = next.split(/[?#]/)[0]!
  return path === prefix || path.startsWith(`${prefix}/`) ? next : fallback
}
