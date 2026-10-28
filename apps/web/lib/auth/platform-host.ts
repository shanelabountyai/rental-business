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
