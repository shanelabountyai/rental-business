import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Focus has to be visible, and it has to survive a form submission (R-107a).
//
// Both rules below were broken across the whole product, and neither is
// catchable by axe, by typecheck, or by a reviewer reading a diff: one is a
// class list that LOOKS like it has a focus ring, and the other is a single
// attribute on a component nobody re-reads. So this walks the source and fails
// the build instead — the same instrument, and the same argument, as
// app/route-guards.test.ts.

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/// Every `className="…"` and `className={`…`}` in the file, with its line.
function classLists(source: string): { classes: string; line: number }[] {
  const found: { classes: string; line: number }[] = []
  // No `s` flag - the tsconfig target predates it, and it was never needed:
  // a negated character class already matches newlines, which is what a
  // multi-line class list is.
  const pattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g
  for (const match of source.matchAll(pattern)) {
    found.push({
      classes: match[1] ?? match[2] ?? '',
      line: source.slice(0, match.index).split('\n').length,
    })
  }
  return found
}

describe('focus visibility', () => {
  it('NAMES THE RING COLOUR wherever it draws a focus ring', () => {
    // Tailwind v4 defaults `--tw-ring-color` to `currentcolor` and
    // `--tw-ring-offset-color` to white. On a `text-background` button
    // currentColor IS the background — so `focus-visible:ring-2
    // focus-visible:ring-offset-2 focus-visible:outline-none` with no ring
    // colour drew a white ring behind a white gap on a white page, at 1.00:1,
    // having already removed the browser's own indicator. Thirteen buttons
    // shipped that way, because the class list reads as though it is handled.
    //
    // Ten more relied on currentColor happening to be dark. Those passed by
    // luck rather than by design, and would have broken silently the first
    // time somebody restyled the text.
    const offenders: string[] = []
    for (const file of walk(WEB_DIR)) {
      for (const { classes, line } of classLists(readFileSync(file, 'utf8'))) {
        if (classes.includes('focus-visible:ring-2') && !classes.includes('ring-ring')) {
          offenders.push(`${file.slice(WEB_DIR.length)}:${line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('NEVER DISABLES THE SUBMIT BUTTON, because that blurs it', () => {
    // A focused element that becomes `disabled` is blurred by the browser, so
    // `disabled={pending}` threw keyboard focus to <body> on every press of
    // every form in the product — and removed the button from the
    // accessibility tree, so the swap to "Working…" was announced to nobody.
    // `aria-disabled` + `aria-busy` + a click guard does the one thing
    // `disabled` was actually needed for.
    const source = readFileSync(join(WEB_DIR, 'components/auth-form.tsx'), 'utf8')
    const submit = source.slice(source.indexOf('export function SubmitButton'))
    expect(submit).toContain('aria-disabled')
    expect(submit).toContain('aria-busy')
    // The negative is the assertion that matters: `aria-disabled` could be
    // added alongside a reinstated `disabled` and the defect would be back.
    expect(submit.slice(0, submit.indexOf('</button>'))).not.toMatch(/\sdisabled=/)
  })

  it('keeps the base outline fallback above 3:1', () => {
    // `* { outline-ring/50 }` is the only focus indicator on any control that
    // sets none of its own. At 50% alpha over white --ring composites to
    // 1.54:1 — a fallback that fails the criterion, which is worse than none
    // because it looks handled.
    // Asserted against the `@apply` LINES, not the whole file — the first
    // draft of this test read the file and failed on the comment above the
    // rule explaining why the alpha was removed.
    const css = readFileSync(join(WEB_DIR, 'app/globals.css'), 'utf8')
    const applies = css.split('\n').filter((line) => line.includes('@apply'))
    expect(applies.some((line) => line.includes('outline-ring'))).toBe(true)
    expect(applies.filter((line) => line.includes('outline-ring/'))).toEqual([])
  })
})
