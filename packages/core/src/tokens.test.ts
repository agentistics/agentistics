import { describe, expect, it } from 'bun:test'
import {
  EMPTY_TOKENS, TOKEN_PARTS, addTokens, readTokens, sessionTokenTotal, sessionTokens,
  sumTokens, tokenHelp, tokenLabel, tokenShares, totalTokens, totalTokensExplained,
  tokenSharePct, usageTokenTotal, usageTokens,
} from './tokens'
import type { Lang } from './i18n'
import type { SessionMeta } from './types'

/** A session shaped like the ones this bug was found on: the cache dwarfs the conversation. */
const sess = (over: Partial<SessionMeta> = {}) => ({
  input_tokens: 186,
  output_tokens: 69_600,
  cache_read_input_tokens: 9_100_000,
  cache_creation_input_tokens: 640_000,
  ...over,
}) as SessionMeta

describe('counting', () => {
  it('adds every billed counter, not just the conversation', () => {
    // The regression itself. `input + output` here is 69.786 against a real 9.809.786 — the exact
    // shape of the session drawer reporting 69,8K beside a cockpit reporting 9,8M.
    expect(sessionTokenTotal(sess())).toBe(9_809_786)
    expect(sessionTokens(sess()).input + sessionTokens(sess()).output).toBe(69_786)
  })

  it('treats an absent counter as zero, not as absent data', () => {
    const partial = { input_tokens: 10, output_tokens: 5 } as SessionMeta
    expect(sessionTokens(partial)).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })
    expect(sessionTokenTotal(partial)).toBe(15)
  })

  it('treats tokens_unavailable as absent even when model_usage is present', () => {
    const unavailable = sess({
      tokens_unavailable: true,
      model_usage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
    })
    expect(sessionTokenTotal(unavailable)).toBeUndefined()
  })

  it('reads a ModelUsage into the same four counters', () => {
    expect(usageTokens({
      inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
    })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
    expect(usageTokenTotal({ inputTokens: 1, outputTokens: 2 })).toBe(3)
    expect(usageTokenTotal(undefined)).toBe(0)
  })

  it('sums per counter, and an empty sum is zero rather than nothing', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
    expect(addTokens(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8 })
    expect(sumTokens([a, a, a])).toEqual({ input: 3, output: 6, cacheRead: 9, cacheWrite: 12 })
    expect(sumTokens([])).toEqual(EMPTY_TOKENS)
  })

  it('separates what the model READ from what it was billed for', () => {
    // Output is the one counter that is not read: it is produced. A hit rate computed against the
    // grand total would be diluted by it and would read differently on an output-heavy session.
    const b = sessionTokens(sess())
    expect(readTokens(b)).toBe(186 + 9_100_000 + 640_000)
    expect(totalTokens(b) - readTokens(b)).toBe(69_600)
  })

  it('yields shares that add to 1, and zeroes rather than NaN on an empty breakdown', () => {
    const s = tokenShares(sessionTokens(sess()))
    expect(s.input + s.output + s.cacheRead + s.cacheWrite).toBeCloseTo(1, 10)
    // A bare `part / total` puts NaN into a CSS width, which renders as a bar of no width and no
    // error — the failure mode a chart cannot tell you about.
    expect(tokenShares(EMPTY_TOKENS)).toEqual(EMPTY_TOKENS)
    for (const part of TOKEN_PARTS) expect(Number.isNaN(tokenShares(EMPTY_TOKENS)[part])).toBe(false)
  })
})

describe('the vocabulary', () => {
  const LANGS: Lang[] = ['en', 'pt']

  it('gives every kind a label AND an explanation, in both languages', () => {
    // The rule this file exists to enforce: a label may not ship without its reason. A total with
    // no explanation reads as a fault at these magnitudes.
    for (const lang of LANGS) {
      for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'read', 'conversation'] as const) {
        expect(tokenLabel(kind, lang).length).toBeGreaterThan(0)
        // Long enough to be a sentence, not a restatement of the label.
        expect(tokenHelp(kind, lang).length).toBeGreaterThan(40)
      }
    }
  })

  it('never prints 0% for a quantity that exists', () => {
    // Found by opening the panel on a real machine: output was 64.2M of a 17.8B total and rendered
    // as `0%`, with the sentence reading "output, the most expensive token, is 0%". A confident zero
    // over a real number is the exact lie this whole module exists to remove.
    expect(tokenSharePct(64_200_000, 17_800_000_000)).toBe('<1%')
    expect(tokenSharePct(1, 1_000_000)).toBe('<1%')
    // A true zero still reads as zero — `<1%` there would invent a quantity.
    expect(tokenSharePct(0, 1000)).toBe('0%')
    expect(tokenSharePct(0, 0)).toBe('0%')
    // And the ordinary case is unchanged.
    expect(tokenSharePct(96, 100)).toBe('96%')
    expect(tokenSharePct(1, 100)).toBe('1%')
  })

  it('explains a headline total by naming what dominates it', () => {
    for (const lang of LANGS) {
      const said = totalTokensExplained(sessionTokens(sess()), lang)
      // 9.100.000 / 9.809.786 = 92,8 % -> 93 %
      expect(said).toContain('93%')
    }
  })

  it('says there is nothing rather than dividing by zero', () => {
    for (const lang of LANGS) {
      expect(totalTokensExplained(EMPTY_TOKENS, lang)).not.toContain('NaN')
      expect(totalTokensExplained(EMPTY_TOKENS, lang).length).toBeGreaterThan(0)
    }
  })
})
