import { platformHandlers } from '@/platform-auth.ts'

// The platform console's own Auth.js endpoints (R-294b), beside the org
// instance's at /api/auth. The proxy serves this path on PLATFORM_HOST only.
export const runtime = 'nodejs'

export const { GET, POST } = platformHandlers
