// Explicit .js extension, not the bare './generated/client' directory: Next.js
// and Vite's bundler resolution paper over a directory import, but plain Node
// running a .mts script directly does not, and fails with
// ERR_UNSUPPORTED_DIR_IMPORT. The extension is correct everywhere either way -
// it is the file Prisma actually emits.
import { PrismaClient } from './generated/client/index.js'

// Reused across hot reloads in dev so Next.js doesn't open a new pool per edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export * from './generated/client/index.js'
