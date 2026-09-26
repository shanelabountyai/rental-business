import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// SEC-11: every `currentScope(actor, permission)` builds its scope from the
// permission the caller was GUARDED with. It used to default to
// `property.read`, and ~70 pages guarded by `requireScope('lease.read')`,
// `'ledger.read'`, `'confidential.read'` ... then listed rows under the
// broader read - a maintenance tech with a manager grant on one house read
// every lease and rent roll in the portfolio. The default is gone (a missing
// argument is a type error); this holds the argument to the guard.
//
// ponytail: regex, not an AST - same trade as server-actions.test.ts.

const ROOT = join(__dirname, '../..')
const IMPORT = /import \{[^}]*\bcurrentScope(?:\s+as\s+(\w+))?[^}]*\} from '@\/lib\/scope\/current-scope\.ts'/
const GUARD = /\brequire(?:Scope|Permission)\(\s*'([a-z.]+)'/g

/// Callers with no permission guard of their own, and why their permission is right.
const UNGUARDED: Record<string, string> = {
  'app/(admin)/layout.tsx': 'property.read', // the switcher: what the actor may SEE
  'app/api/calendar/[token]/route.ts': 'property.read', // token-authenticated feed of visit times
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const callers = ['app', 'lib']
  .flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, 'utf8') }))
  .flatMap(({ file, source }) => {
    const imported = source.match(IMPORT)
    return imported ? [{ file, source, name: imported[1] ?? 'currentScope' }] : []
  })

describe('currentScope callers (SEC-11)', () => {
  it('finds the callers', () => {
    expect(callers.length).toBeGreaterThan(60)
  })

  it.each(callers)('$file scopes by the permission it was guarded with', ({ file, source, name }) => {
    // Every call, by whatever name the file imported it under - an alias
    // (`switcherScope`) is exactly how three callers hid from a grep.
    const calls = [
      ...source.matchAll(new RegExp(`\\b${name}\\(\\s*[a-zA-Z_]\\w*\\s*(?:,\\s*'([a-z.]+)')?\\s*\\)`, 'g')),
    ]
    expect(calls.length, `${file} imports ${name} but no call matched`).toBeGreaterThan(0)
    const guards = new Set([...source.matchAll(GUARD)].map((m) => m[1]))
    for (const [call, permission] of calls) {
      expect(permission, `${call} names no permission`).toBeDefined()
      if (guards.size > 0) {
        expect([...guards], `${call} in a file guarded by ${[...guards]}`).toContain(permission)
      } else {
        expect(UNGUARDED[file], `${file} has no guard; add it to UNGUARDED with a reason`).toBe(
          permission,
        )
      }
    }
  })
})
