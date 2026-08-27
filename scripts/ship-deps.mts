/**
 * Nothing the deploy builds may import a package the deploy might not have.
 *
 * R-120: `@axe-core/playwright` is a devDependency, `e2e/fixtures.ts` imported
 * it, and `apps/web/tsconfig.json` deliberately includes the e2e suite - so
 * `next build` typechecked a file that imports a package the production
 * install does not guarantee, and seven consecutive deploys died on it while
 * lint, typecheck and the local build all stayed green. R-120 excluded `e2e`
 * from the build config and stopped there.
 *
 * R-121 found the same hole one directory over: every `*.test.ts` under
 * `apps/web` and `packages` imports `vitest`, which the lockfile marks `dev`
 * exactly as it marks `@axe-core/playwright`, and all hundred-odd of them
 * were still inside `tsconfig.build.json`. An instance was fixed; the class
 * was not. This is the check for the class.
 *
 * WHY THIS RATHER THAN A PRODUCTION INSTALL. The faithful reproduction is
 * `npm ci --omit=dev` and a build, which takes minutes and destroys the
 * working `node_modules` the rest of the gate needs. This asks the same
 * question in a second and answers it better: it names the file AND the
 * package, where a build names only the first import that happened to fail.
 *
 * The two inputs are both authoritative rather than guessed:
 *   - the file list comes from `tsc --listFilesOnly` on the BUILD config, so
 *     it is literally what the deploy typechecks and cannot drift from it.
 *     `--listFilesOnly` does not typecheck, verified: it exits 0 with a
 *     deliberate type error in the tree, so this check answers its own
 *     question whether or not `npm run typecheck` is green;
 *   - the dev set comes from `package-lock.json`'s own `dev: true` markers,
 *     which is what an install reads, not from the package.json stanza a
 *     package happens to be written in. `@playwright/test` sits in
 *     devDependencies and is NOT marked dev in the lock, because something in
 *     the production tree depends on it - so it is genuinely safe and this
 *     check correctly stays quiet about it (R-119's leftover).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const buildConfig = 'apps/web/tsconfig.build.json'

/// Every package the lockfile marks `dev: true`, by bare name.
function devPackages(): Set<string> {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  const names = new Set<string>()
  for (const [key, entry] of Object.entries<{ dev?: boolean }>(lock.packages ?? {})) {
    if (!entry?.dev) continue
    // "node_modules/a/node_modules/b" -> "b": a nested copy is still that
    // package, and the last segment after the final `node_modules/` is it.
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (name) names.add(name)
  }
  return names
}

/// What the deploy actually typechecks: our own sources, no node_modules.
function shippingFiles(): string[] {
  const listed = execFileSync(
    'npx',
    ['tsc', '--noEmit', '--listFilesOnly', '-p', buildConfig],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((f) => f && !f.includes('/node_modules/') && f.startsWith(repoRoot))
}

/// The bare package name an import specifier names, or null for a relative
/// path, a URL, or a `@/`-aliased in-repo import.
function packageOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('@/') || specifier.includes(':')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

// Static `import`/`export ... from`, `import(...)` and `require(...)`. Kept to
// one regex on purpose: a real module graph needs a resolver, and the thing
// being caught is a literal package name in a source file.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

const dev = devPackages()
const offences: string[] = []

for (const file of shippingFiles()) {
  const source = readFileSync(file, 'utf8')
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    const pkg = packageOf(specifier!)
    if (pkg && dev.has(pkg)) {
      offences.push(`${path.relative(repoRoot, file)} imports ${pkg}`)
    }
  }
}

if (offences.length > 0) {
  console.error(
    `\n${offences.length} import(s) of a dev-only package from code the deploy builds.\n` +
      `Either the file does not belong in ${buildConfig}, or the package does not belong in devDependencies.\n`,
  )
  for (const offence of [...new Set(offences)].sort()) console.error(`  ${offence}`)
  console.error('')
  process.exit(1)
}

console.log(`check:ship-deps - clean (${dev.size} dev packages, no shipping file imports one)`)
