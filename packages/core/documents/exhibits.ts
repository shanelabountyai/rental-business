// The exhibit index every assembled packet carries (D-50), lifted out of
// R-083's attorney packet when R-081d needed the identical thing.
//
// D-50's RULE IS THE WHOLE OF THIS FILE: never silently drop an attachment,
// always name what could not be included. It was settled when the ledger
// statement started embedding the payment provider's invoices, and it applies
// unchanged to an attorney packet and to a tax packet - a bundle quietly
// missing the one form that would not parse is worse than one that never
// claimed to have it.
//
// Two packets said this in two places; two copies of an honesty rule is one
// copy that eventually stops being honest.

import type { DocumentBlock } from './blocks.ts'

export interface PacketExhibit {
  label: string
  /// What it is - "Notice of proof of service", "Form 1098".
  kind: string
  /// When the underlying thing happened, already formatted for display.
  occurredOn: string | null
  /// False when the file could not be read or would not parse. Named on the
  /// index either way (D-50).
  attached: boolean
}

/**
 * The numbered exhibit list, plus the sentence naming anything absent.
 *
 * `emptyText` differs per packet only because "no exhibits" means something
 * different in each - an eviction with no photographs is an unusual case, a
 * tax packet with no 1098 is Tuesday.
 */
export function exhibitIndexBlocks(
  exhibits: readonly PacketExhibit[],
  emptyText: string,
): DocumentBlock[] {
  if (exhibits.length === 0) return [{ kind: 'paragraph', text: emptyText }]

  const blocks: DocumentBlock[] = exhibits.map((exhibit, index) => {
    const when = exhibit.occurredOn ? ` · ${exhibit.occurredOn}` : ''
    return {
      kind: 'mono',
      text: `${String(index + 1).padStart(3)}. ${exhibit.kind}: ${exhibit.label}${when}${
        exhibit.attached ? '' : '   [NOT ATTACHED]'
      }`,
    }
  })

  const unattached = exhibits.filter((exhibit) => !exhibit.attached).length
  if (unattached > 0) {
    // The honest sentence, not a silent gap. Phrased so a reader knows to go
    // asking for the missing file rather than concluding it never existed.
    blocks.push({
      kind: 'paragraph',
      text: `${unattached} ${
        unattached === 1 ? 'exhibit is' : 'exhibits are'
      } listed above but could not be attached to this file — the underlying record exists in the system and can be produced separately.`,
    })
  }

  return blocks
}
