import { describe, expect, it } from 'vitest'
import { smsLength } from './sms-length.ts'

describe('smsLength', () => {
  it('counts plain text as GSM-7, 160 then 153 a segment', () => {
    expect(smsLength('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 })
    expect(smsLength('a'.repeat(161)).segments).toBe(2)
    expect(smsLength('a'.repeat(307)).segments).toBe(3)
  })
  it('counts extended characters as two septets', () => {
    expect(smsLength('['.repeat(81)).segments).toBe(2)
  })
  it('flips the whole message to UCS-2 on one curly quote', () => {
    expect(smsLength(`${'a'.repeat(100)}’`)).toMatchObject({ encoding: 'UCS-2', segments: 2 })
  })
})
