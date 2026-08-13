import { describe, expect, it } from 'vitest'
import { classifyOptOutKeyword, optOutReply } from './opt-out.ts'

// The asymmetry these tests exist to protect is stated in opt-out.ts: a
// missed STOP is embarrassing, a FALSE STOP silently unsubscribes somebody
// from `entry_notice` - the category LOCKED_CATEGORIES says a tenant may not
// turn off, because it is the legally significant notice that somebody is
// entering their home.

describe('classifyOptOutKeyword', () => {
  it('recognises the whole CTIA stop set, whatever the case', () => {
    for (const word of ['STOP', 'stop', 'Stop', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'Quit']) {
      expect(classifyOptOutKeyword(word)).toBe('STOP')
    }
  })

  it('recognises start and help', () => {
    for (const word of ['START', 'unstop', 'Yes']) {
      expect(classifyOptOutKeyword(word)).toBe('START')
    }
    for (const word of ['HELP', 'info']) {
      expect(classifyOptOutKeyword(word)).toBe('HELP')
    }
  })

  it('tolerates surrounding whitespace and a trailing full stop', () => {
    // Handsets capitalise unpredictably, autocorrect adds punctuation, and a
    // trailing newline is not a different intention.
    expect(classifyOptOutKeyword('  stop  ')).toBe('STOP')
    expect(classifyOptOutKeyword('Stop.')).toBe('STOP')
    expect(classifyOptOutKeyword('STOP!')).toBe('STOP')
    expect(classifyOptOutKeyword('stop\n')).toBe('STOP')
  })

  it('DOES NOT match a keyword inside a sentence', () => {
    // The expensive mistake, and the reason this is not `includes()`. Every
    // one of these is a real message somebody would send a landlord.
    expect(classifyOptOutKeyword('please stop the leak under the sink')).toBeNull()
    expect(classifyOptOutKeyword('Can you stop by tomorrow?')).toBeNull()
    expect(classifyOptOutKeyword('the water will not stop')).toBeNull()
    expect(classifyOptOutKeyword('STOP THE WATER')).toBeNull()
    expect(classifyOptOutKeyword('yes that works')).toBeNull()
    expect(classifyOptOutKeyword('help me please')).toBeNull()
    expect(classifyOptOutKeyword('I need help with the heater')).toBeNull()
  })

  it('is null for an empty or whitespace-only body', () => {
    // An MMS with a photo and no text arrives this way, and it is a
    // maintenance request with a picture, not an opt-out.
    expect(classifyOptOutKeyword('')).toBeNull()
    expect(classifyOptOutKeyword('   ')).toBeNull()
    expect(classifyOptOutKeyword('\n')).toBeNull()
  })

  it('is null for a word that merely starts with a keyword', () => {
    expect(classifyOptOutKeyword('stopped')).toBeNull()
    expect(classifyOptOutKeyword('helpful')).toBeNull()
    expect(classifyOptOutKeyword('started')).toBeNull()
  })
})

describe('optOutReply', () => {
  it('says NOTHING back to a STOP', () => {
    // The carrier sends its own confirmation and then blocks the number, so
    // anything queued here would be undeliverable and would sit in the
    // outbox failing for ever.
    expect(optOutReply('STOP', 'Cedar Homes')).toBeNull()
  })

  it('confirms a START and names the business', () => {
    const reply = optOutReply('START', 'Cedar Homes')
    expect(reply).toContain('Cedar Homes')
    expect(reply).toContain('STOP')
  })

  it('answers HELP with what we are and how to leave', () => {
    const reply = optOutReply('HELP', 'Cedar Homes')
    expect(reply).toContain('Cedar Homes')
    expect(reply).toContain('STOP')
    expect(reply).toMatch(/rates may apply/i)
  })
})
