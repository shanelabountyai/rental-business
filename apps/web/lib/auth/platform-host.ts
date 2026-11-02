// Which host is the platform console's (PRD 11 §2.2, D-350, R-294b). Pure and
// free of Prisma so the proxy can import it.
//
// PLATFORM_HOST is a bare hostname, no port: the bare base in production,
// `platform.localhost` in dev and e2e (Chromium resolves `*.localhost` to
// loopback, so no DNS is needed). Unset = the console does not exist here.

export function isPlatformHost(
  host: string | null,
  platform: string | undefined = process.env.PLATFORM_HOST,
): boolean {
  const want = platform?.trim().toLowerCase()
  return Boolean(want) && (host ?? '').split(':')[0].trim().toLowerCase() === want
}

/// True when the request must be a 404: a console path on any other host, or
/// anything but the console and `/` on the console's host. Both directions,
/// so neither session kind can be driven from the other's host.
export function platformRouteRefused(
  host: string | null,
  pathname: string,
  platform: string | undefined = process.env.PLATFORM_HOST,
): boolean {
  const consolePath = pathname === '/platform' || pathname.startsWith('/platform/')
  return isPlatformHost(host, platform) ? !consolePath && pathname !== '/' : consolePath
}

/// The host the BROWSER asked for (R-276, D-379): `x-forwarded-host` first,
/// then `host`. A server action that calls `redirect()` has Next render the
/// target in the same response, by fetching it from the server's own origin
/// (`initURL`, `localhost` under `next start`). That fetch forwards the
/// request's headers but not its Host, so a page read off `host` alone ran as
/// org #0 and bounced an org's session to /login. Next sets
/// `x-forwarded-host` from the real Host only when it is absent, and Vercel's
/// edge sets it on every request, so it names the browser's host on both legs.
/// A client can send its own on a bare `next start`; nothing trusts the host
/// alone, since every check behind it still needs that org's session, token
/// or secret.
export function requestHost(headers: { get(name: string): string | null }): string | null {
  return headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')
}
