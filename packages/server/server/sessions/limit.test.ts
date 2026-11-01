import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  HALF_DAY_MS,
  LIMIT_RULES,
  detectLimit,
  limitCleared,
  limitRuleFor,
  parseResetAt,
} from './limit'

// ── Lines below are VERBATIM from live panes, 2026-08-14, claude 2.1.231. ────────────────────────
//
// Captured with `tmux capture-pane -p -S -5000` and re-read through `cat -A`, which is the only way
// the two bytes that matter are visible at all:
//
//   `  M-bM-^NM-? M-BM- You've hit your session limit M-BM-7 resets 6:30pm (America/Sao_Paulo)$`
//
// `M-BM- ` is C2 A0 — a NON-BREAKING space before `You've`. `M-BM-7` is C2 B7 — a MIDDLE DOT, not a
// hyphen and not an asterisk. `FIXTURE BYTES` below fails the build if either is ever normalised
// away by an editor or a well-meaning cleanup, because a fixture quietly rewritten in ASCII would
// let a pattern written in ASCII pass while matching nothing on a real screen.

/** The tool-result form, both lines, exactly as the pane drew them. */
const CLAUDE_BANNER = [
  "  ⎿  You've hit your session limit · resets 6:30pm (America/Sao_Paulo)",
  '     /upgrade to increase your usage limit.',
]

/**
 * The same event reported through a SUBAGENT failure, from the pane next door.
 *
 * The limit belongs to the account rather than to the agent that reached it first, so the parent's
 * next request fails identically — in the pane this came from, both forms were on screen together.
 */
const CLAUDE_AGENT_ERROR =
  '● Agent "Re-review Task 11 after fix" failed: Agent terminated early due to an API error: ' +
  "You've hit your session limit · resets 6:30pm (America/Sao_Paulo)"

/** A tail from a session that is simply talking — nothing here may be read as a limit. */
const ORDINARY_TAIL = [
  '● Ran 2 shell commands',
  '  ⎿  Read 40 lines',
  '● The parser now folds every agent of a session into it.',
]

/** Local wall clock on a date with no DST transition anywhere, so the arithmetic is portable. */
const at = (hour: number, minute = 0, day = 14) =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime()

const claude = () => limitRuleFor('claude')

describe('FIXTURE BYTES', () => {
  it('still carries the non-breaking space and the middle dot that were captured', () => {
    // Guarding the FIXTURE, not the rule. If this line is ever retyped in plain ASCII the tests
    // below keep passing while the feature stops seeing a single real frame.
    expect(CLAUDE_BANNER[0]).toContain(' ')
    expect(CLAUDE_BANNER[0]).toContain('·')
    expect(CLAUDE_AGENT_ERROR).toContain('·')
  })

  it('would not be matched by the pattern anyone would have guessed', () => {
    // The point of capturing instead of remembering: the obvious pattern, written with an ASCII
    // space and an ASCII separator, matches none of this.
    expect(/session limit - resets/.test(CLAUDE_BANNER[0]!)).toBe(false)
    expect(/limit \* resets/.test(CLAUDE_BANNER[0]!)).toBe(false)
  })
})

describe('opencode limit banner (strings measured in opencode 1.19.5)', () => {
  const rule = LIMIT_RULES.opencode!
  const hit = (line: string) => detectLimit({ tail: [line], rule, nowMs: 0 })
  it('recognises the free, Go and quota errors it prints', () => {
    for (const l of ['Free usage exceeded, subscribe to Go', 'Free limit reached', 'Go limit reached',
      'AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go', 'Quota exceeded. Check your plan and billing details.', 'Error: Rate limit exceeded'])
      expect(hit(l)?.raw).toBe(l)
  })
  it('does not treat a line merely quoting "rate limit" as blocked, and states no reset', () => {
    expect(hit('the retry handler waits on a rate limit then continues')).toBeUndefined()
    expect(hit('Go limit reached')?.resetsAtText).toBeUndefined()
  })
})

describe('LIMIT_RULES', () => {
  it('declares an entry for every harness, so a new one cannot be forgotten', () => {
    for (const h of HARNESS_ORDER) {
      expect(LIMIT_RULES).toHaveProperty(h)
    }
  })

  it('leaves every unprobed harness null rather than guessing a banner for it', () => {
    for (const h of HARNESS_ORDER) {
      if (h === 'claude' || h === 'opencode') continue
      expect(LIMIT_RULES[h]).toBeNull()
      expect(limitRuleFor(h)).toBeUndefined()
    }
  })

  it('never uses the g flag, which would make .test() alternate', () => {
    for (const h of HARNESS_ORDER) {
      const r = LIMIT_RULES[h]
      if (!r) continue
      for (const re of [...r.banner, ...(r.resetAt ? [r.resetAt] : [])]) {
        expect(re.global).toBe(false)
      }
    }
  })

  it('records provenance for every harness that has rules', () => {
    for (const h of HARNESS_ORDER) {
      const r = LIMIT_RULES[h]
      if (!r) continue
      expect(r.probed).toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('spells every gap `\\s+` and never a literal space', () => {
    // THE regression guard the whole module is written around. A pattern retyped with an ordinary
    // space still looks correct in review and matches nothing on a screen whose separator is a
    // non-breaking space — it does not throw, it reports every blocked session as fine.
    for (const h of HARNESS_ORDER) {
      const r = LIMIT_RULES[h]
      if (!r) continue
      for (const re of [...r.banner, ...(r.resetAt ? [r.resetAt] : [])]) {
        expect(re.source).not.toContain(' ')
        expect(re.source).not.toContain(' ')
        expect(re.source).not.toContain('·')
      }
    }
  })
})

describe('detectLimit', () => {
  it('reads the captured banner, non-breaking space and middle dot included', () => {
    const hit = detectLimit({ tail: CLAUDE_BANNER, rule: claude(), nowMs: at(18, 37) })
    expect(hit).toBeDefined()
    expect(hit!.resetsAtText).toBe('6:30pm')
    expect(hit!.resetsAtMs).toBe(at(18, 30))
  })

  it('quotes the line that SAYS something, not the newer one that says /upgrade', () => {
    // The bug this pins: `/upgrade to increase your usage limit.` is printed BELOW the banner, so a
    // newest-first scan meets it first. Taking the reset off that same line came back with none —
    // and an absent reset counts as cleared, so every blocked session read as ready to resume.
    const hit = detectLimit({ tail: CLAUDE_BANNER, rule: claude(), nowMs: at(18, 0) })
    expect(hit!.raw).toContain('hit your session limit')
    expect(hit!.raw).not.toContain('/upgrade')
    expect(hit!.resetsAtMs).toBe(at(18, 30))
  })

  it('still sees a limit when the tail cut between the two lines', () => {
    const hit = detectLimit({ tail: [CLAUDE_BANNER[1]!], rule: claude(), nowMs: at(18, 0) })
    expect(hit).toBeDefined()
    expect(hit!.resetsAtMs).toBeUndefined()
    // Documented, and deliberately the forgiving direction: one wasted prompt beats a row that
    // nothing can ever clear.
    expect(limitCleared(hit, at(18, 0))).toBe(true)
  })

  it('reads the subagent failure form too', () => {
    const hit = detectLimit({ tail: [CLAUDE_AGENT_ERROR], rule: claude(), nowMs: at(18, 0) })
    expect(hit).toBeDefined()
    expect(hit!.resetsAtMs).toBe(at(18, 30))
  })

  it('takes the NEWEST banner when a session hit the limit twice', () => {
    // Synthetic — nobody caught one pane hitting the limit twice inside one tail. The banner text is
    // the captured one; only the second reset time is invented, and it is labelled here rather than
    // left to read as another capture.
    const tail = [
      "  ⎿  You've hit your session limit · resets 1:30pm (America/Sao_Paulo)",
      '● Kept going for a while.',
      "  ⎿  You've hit your session limit · resets 6:30pm (America/Sao_Paulo)",
    ]
    const hit = detectLimit({ tail, rule: claude(), nowMs: at(18, 37) })
    expect(hit!.resetsAtText).toBe('6:30pm')
  })

  it('says nothing about an ordinary tail', () => {
    expect(detectLimit({ tail: ORDINARY_TAIL, rule: claude(), nowMs: at(18, 0) })).toBeUndefined()
    expect(detectLimit({ tail: [], rule: claude(), nowMs: at(18, 0) })).toBeUndefined()
  })

  it('detects nothing at all for a harness nobody probed', () => {
    // Not "this harness has no limits" — "we have never seen one", which the UI states in words.
    expect(detectLimit({ tail: CLAUDE_BANNER, rule: limitRuleFor('codex'), nowMs: at(18, 0) }))
      .toBeUndefined()
  })
})

describe('parseResetAt', () => {
  it('reads a reset that already passed as TODAY, never tomorrow', () => {
    // The acceptance case, and the one worth being loudest about: 18:30 read at 18:37 is OVER.
    // Rolling it forward a day parks the whole fleet at the exact instant the resume should fire.
    expect(parseResetAt('6:30pm', at(18, 37))).toBe(at(18, 30));
    expect(limitCleared({ raw: '', resetsAtMs: parseResetAt('6:30pm', at(18, 37)) }, at(18, 37)))
      .toBe(true)
  })

  it('reads a reset still to come as today', () => {
    expect(parseResetAt('6:30pm', at(18, 0))).toBe(at(18, 30))
    expect(limitCleared({ raw: '', resetsAtMs: at(18, 30) }, at(18, 0))).toBe(false)
  })

  it('rolls a reset across MIDNIGHT into tomorrow', () => {
    // The mirror of the case above, and the one the first cut of this module got wrong: a banner
    // printed at 23:50 saying `resets 1:00am` means the 1am one hour away. Read as today's it lands
    // 23 hours in the past, and a hard-blocked session reports itself free to resume.
    expect(parseResetAt('1:00am', at(23, 50))).toBe(at(1, 0, 15))
  })

  it('rolls a late-evening reset read after midnight back to yesterday', () => {
    expect(parseResetAt('11:00pm', at(0, 10))).toBe(at(23, 0, 13))
  })

  it('never lands further than half a day from the moment it is read', () => {
    for (const hour of [0, 3, 6, 9, 12, 15, 18, 21]) {
      for (const text of ['12am', '1:15am', '6:30am', '12pm', '1:15pm', '6:30pm', '11:45pm']) {
        const now = at(hour, 20)
        const ms = parseResetAt(text, now)
        expect(ms).toBeDefined()
        expect(Math.abs(ms! - now)).toBeLessThanOrEqual(HALF_DAY_MS)
      }
    }
  })

  it('reads 12am as midnight and 12pm as noon', () => {
    expect(parseResetAt('12am', at(1, 0))).toBe(at(0, 0))
    expect(parseResetAt('12pm', at(13, 0))).toBe(at(12, 0))
  })

  it('accepts the bare-hour and spaced forms the banner could print', () => {
    expect(parseResetAt('6pm', at(18, 37))).toBe(at(18, 0))
    expect(parseResetAt('6 PM', at(18, 37))).toBe(at(18, 0))
  })

  it('refuses anything it cannot read, rather than inventing an instant', () => {
    for (const junk of ['', 'soon', '25pm', '6:99pm', '0am', '18:30', '6:30']) {
      expect(parseResetAt(junk, at(12, 0))).toBeUndefined()
    }
  })
})

describe('limitCleared', () => {
  it('treats no hit at all as cleared', () => {
    expect(limitCleared(undefined, at(12, 0))).toBe(true)
  })

  it('treats an unknown reset as cleared', () => {
    expect(limitCleared({ raw: 'blocked' }, at(12, 0))).toBe(true)
  })

  it('clears exactly AT the reset, not a millisecond later', () => {
    expect(limitCleared({ raw: '', resetsAtMs: at(18, 30) }, at(18, 30))).toBe(true)
    expect(limitCleared({ raw: '', resetsAtMs: at(18, 30) }, at(18, 30) - 1)).toBe(false)
  })
})
