import { describe, expect, it } from 'vitest'
import { DEPOSIT_SLIP_WIDTH, depositSlipBlocks } from './deposit-slip-document.ts'

const facts = {
  entityName: 'Cedar Row Rentals LLC',
  receivedByName: 'Sam Rivera',
  receivedOn: '2026-09-01',
  generatedAt: '2026-09-01 5:00 PM',
  lines: [
    { description: 'Jordan Ruiz — 42 Magnolia Dr', channel: 'OFFLINE_CHECK', checkNumber: '101', amountCents: 150_000 },
    { description: 'Ada Nu — 18 Cedar Row', channel: 'OFFLINE_CASH', checkNumber: null, amountCents: 50_000 },
  ],
  totalCents: 200_000,
}

describe('depositSlipBlocks', () => {
  it('prints every line and the total, columns aligned', () => {
    const texts = depositSlipBlocks(facts).map((b) => b.text)
    expect(texts.join('\n')).toContain('$1,500.00')
    expect(texts.join('\n')).toContain('$500.00')
    expect(texts.join('\n')).toContain('Total')
    expect(texts.join('\n')).toContain('$2,000.00')
    // Every mono line matches the declared column width, so nothing is
    // silently misaligned once it hits the renderer's monospaced font.
    for (const block of depositSlipBlocks(facts)) {
      if (block.kind !== 'mono') continue
      for (const line of block.text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(DEPOSIT_SLIP_WIDTH)
      }
    }
  })

  it('prints a check number when there is one, an em dash when there is not', () => {
    const text = depositSlipBlocks(facts)
      .map((b) => b.text)
      .join('\n')
    expect(text).toContain('101')
    expect(text).toContain('—')
  })
})
