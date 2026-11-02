/// Where Auth.js may send the browser after sign-in or sign-out, as a
/// RELATIVE path (R-276, D-379). Auth.js resolves redirects against AUTH_URL's
/// origin, which is org #0's host, so an absolute one strands a browser whose
/// host-only session cookie lives on an org subdomain or custom domain. A
/// same-origin absolute URL keeps its path; anything else, including a
/// protocol-relative `//host`, goes home rather than off-site.
export function relativeRedirect(url: string, baseUrl: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const target = new URL(url)
    return target.origin === new URL(baseUrl).origin ? `${target.pathname}${target.search}` : '/'
  } catch {
    return '/'
  }
}
