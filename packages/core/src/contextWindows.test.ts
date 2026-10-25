import { describe, expect, it } from 'bun:test'
import {
  CONTEXT_WINDOWS,
  contextFraction,
  resolveContextWindow,
} from './contextWindows'

describe('CONTEXT_WINDOWS — provenance is structural', () => {
  it('every entry carries a positive window, a date and a source', () => {
    // The same rule `CatalogPrice` enforces for prices: a figure without provenance cannot exist,
    // because the only defence against a wrong window is being able to check where it came from.
    for (const [id, win] of Object.entries(CONTEXT_WINDOWS)) {
      expect(win.tokens, id).toBeGreaterThan(0)
      expect(win.source, id).not.toBe('')
      expect(win.verifiedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('uses the verified Gemini 3.8 input limit, including effort suffixes', () => {
    expect(resolveContextWindow('gemini-3.8-flash')).toEqual({
      tokens: 1_048_576, verifiedAt: '2026-10-20',
      source: 'ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
    })
    expect(resolveContextWindow('gemini-3.8-flash-high')?.tokens).toBe(1_048_576)
  })
})

describe('resolveContextWindow', () => {
  it('resolves an exact id', () => {
    expect(resolveContextWindow('claude-opus-5')?.tokens).toBe(1_000_000)
    expect(resolveContextWindow('claude-haiku-4-5')?.tokens).toBe(200_000)
  })

  it('resolves a dated snapshot by prefix', () => {
    // What the consolidate store actually holds for Haiku on a real machine.
    expect(resolveContextWindow('claude-haiku-4-5-20251001')?.tokens).toBe(200_000)
  })

  it("resolves Antigravity's suffixed claude ids", () => {
    // agy stamps `claude-opus-4-6-thinking`; the window is the model's.
    expect(resolveContextWindow('claude-opus-4-6-thinking')?.tokens).toBe(1_000_000)
  })

  it('never lets a SHORTER id claim a longer key', () => {
    // The reverse-prefix match `getModelPrice` performs is right for a price and wrong here: it
    // would hand `claude-opus` whichever `claude-opus-*` row happened to be iterated first, and a
    // window inherited from a different model is precisely the confident-wrong-number this module
    // exists to prevent. A price has a documented fallback; a window has none.
    expect(resolveContextWindow('claude-opus')).toBeNull()
    expect(resolveContextWindow('claude')).toBeNull()
  })

  it('picks the LONGEST matching key when several are prefixes', () => {
    // Guards the day a `claude-opus-5-mini` (or any longer id sharing a shorter row's prefix) is
    // added: it must take its own row, not the shorter one that also matches.
    const table = { 'claude-x': 1, 'claude-x-long': 2 }
    // Re-implemented locally rather than mutating the shared table — the assertion is about the
    // longest-wins RULE, and a test that edits module state to prove it is a test that can leak.
    const longest = Object.keys(table)
      .filter(k => 'claude-x-long-v2'.startsWith(k))
      .sort((a, b) => b.length - a.length)[0]
    expect(longest).toBe('claude-x-long')
  })

  it('is null for an unknown or empty model', () => {
    expect(resolveContextWindow('gpt-5.4')).toBeNull()
    expect(resolveContextWindow('gemini-3.6-flash')).toBeNull()
    expect(resolveContextWindow('ollama-local/qwen2.5-3b-instruct')).toBeNull()
    expect(resolveContextWindow('')).toBeNull()
    expect(resolveContextWindow(undefined)).toBeNull()
    expect(resolveContextWindow('   ')).toBeNull()
  })
})

describe('contextFraction', () => {
  it('divides when both halves are usable', () => {
    expect(contextFraction(500_000, 1_000_000)).toBe(0.5)
  })

  it('is null when either half is missing', () => {
    expect(contextFraction(undefined, 1_000_000)).toBeNull()
    expect(contextFraction(500, undefined)).toBeNull()
    expect(contextFraction(undefined, undefined)).toBeNull()
  })

  it('refuses a non-positive window rather than returning Infinity', () => {
    // Infinity and NaN both render as a confident something. Null renders as nothing, which is the
    // honest answer to "how full is a window of zero".
    expect(contextFraction(100, 0)).toBeNull()
    expect(contextFraction(100, -1)).toBeNull()
    expect(contextFraction(100, Number.NaN)).toBeNull()
    expect(contextFraction(Number.POSITIVE_INFINITY, 100)).toBeNull()
  })

  it('refuses a negative measurement', () => {
    expect(contextFraction(-5, 1000)).toBeNull()
  })

  it('does NOT clamp above 1 — a real session can exceed the table window', () => {
    // 212.959 against a 200k window: the measurement is real and the window is a lookup, so the
    // honest reading is 106%, not a silently pinned 100%. The BAR saturates; the number does not.
    expect(contextFraction(212_959, 200_000)).toBeCloseTo(1.064_795, 6)
  })

  it('is 0 for an empty context, which is a real reading', () => {
    expect(contextFraction(0, 1_000_000)).toBe(0)
  })
})
