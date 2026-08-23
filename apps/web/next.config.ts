import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@rental/db', '@rental/core'],
  experimental: {
    // Next caps a Server Action body at 1 MB by default, and every photo
    // upload in this product goes through one - inspections, notice service,
    // abandonment entries, violation observations, and now loss photographs.
    // A photo off a phone is routinely 2-5 MB, so the default was rejecting
    // the exact evidence those flows exist to capture, with an error that
    // reads as a server fault rather than a size limit. Raised here rather
    // than per-route because it is one shared ceiling and every caller wants
    // the same answer.
    //
    // 25 MB also admits a short walkthrough video, which RISK-07 asks for.
    // It is NOT enough for a long one: a real video path wants a
    // direct-to-storage upload that bypasses the action body entirely, and
    // nothing owns that yet.
    serverActions: { bodySizeLimit: '25mb' },
  },
}

export default nextConfig
