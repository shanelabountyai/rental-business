import { handlers } from '@/auth.ts'

// Auth.js owns /api/auth/*: the sign-in and sign-out endpoints, the CSRF
// token, and the session endpoint. Node runtime, not edge - the providers read
// Postgres through Prisma.
export const runtime = 'nodejs'

export const { GET, POST } = handlers
