import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The exclusions the handoff packet depends on (DOC-06, RISK-09; R-092).
//
// A SOURCE-LEVEL TEST, THE SHAPE R-103 ESTABLISHED, and the reason is the
// same: the rule is one word away from being broken by somebody who has not
// read the file's header, and by the time it is broken the consequence is a
// lockbox code or a household member's name in a document that was emailed to
// a buyer's solicitor. Nothing about the packet's OUTPUT can catch that -
// the query would simply start returning a field the builder would happily
// print.
//
// It reads code lines only, for R-103's reason: the header quotes both column
// names verbatim while explaining why they are absent, and a test that flags
// its own explanation teaches the next person to delete the explanation.

const SOURCE = join(import.meta.dirname, 'handoff-file.ts')

function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return (
        trimmed !== '' &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('///')
      )
    })
}

describe('what the handoff packet must never be able to read', () => {
  const lines = codeLines(SOURCE)

  it('never selects a sealed access code', () => {
    // R-005 made every reveal an individually audited act. A packet that
    // printed them would collapse all of them into one line in a log, in a
    // file that gets forwarded.
    for (const line of lines) {
      expect(line, line.trim()).not.toContain('sealedCode')
    }
  })

  it('never selects a work order’s restricted-party note', () => {
    // R-091 puts a household member's name in that column so a locksmith at a
    // door reads it, and D-107 is what says it goes no further. The JOB is in
    // the packet, correctly - D-109 is explicit that a confidential case's
    // consequences cannot be hidden.
    for (const line of lines) {
      expect(line, line.trim()).not.toContain('restrictedPartyNote')
    }
  })

  it('never reaches into the confidential module', () => {
    // `lib/confidential/queries.ts`'s own header says nothing else should
    // import it, and an export is exactly the convenient place somebody would.
    for (const line of lines) {
      expect(line, line.trim()).not.toContain('confidential')
    }
  })
})
