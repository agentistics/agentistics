import { describe, expect, it } from 'bun:test'
import { canonicalOfTuiMode } from '@agentistics/core'
import { MODE_SPECS, cycleToMode, modeOf, modeSpecFor, type ModeSpec } from './mode-spec'

const claude = modeSpecFor('claude')

/** The four footers, captured from a live session by sending `BTab` four times. */
const FOOTERS = {
  manual: '  ⏸ manual mode on · ? for shortcuts · ← 6 agents                          /rc',
  accept: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 6 agents                      /rc',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← 6 agents                          /rc',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents                         /rc',
  // MODE.NOQ — claude 2.1.310 started with --allow-dangerously-skip-permissions, 2026-10-24.
  bypass: '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 6 agents',
}

const frameWith = (footer: string) => ['some conversation', '', '─'.repeat(80), '❯ ', footer]

describe('modeOf', () => {
  it('names each of the four measured modes', () => {
    expect(modeOf(frameWith(FOOTERS.manual), claude)?.id).toBe('manual')
    expect(modeOf(frameWith(FOOTERS.accept), claude)?.id).toBe('accept-edits')
    expect(modeOf(frameWith(FOOTERS.plan), claude)?.id).toBe('plan')
    expect(modeOf(frameWith(FOOTERS.auto), claude)?.id).toBe('auto')
  })

  it('MANUAL is matched on its own name, not on the cycle hint', () => {
    // It is the one footer that does NOT advertise "(shift+tab to cycle)" — it says
    // "? for shortcuts". Matching on the hint would find three of four and call the fourth unknown.
    expect(FOOTERS.manual).not.toContain('shift+tab')
    expect(modeOf(frameWith(FOOTERS.manual), claude)?.label).toBe('manual mode')
  })

  it('reads the FOOTER only — a transcript that QUOTES a mode is not that mode', () => {
    // This product is developed with this product: a session editing `mode-spec.ts` has these exact
    // strings on screen all day. The same rule `attention-rules.ts` records for its own markers.
    const quoting = [
      'the cycle is: manual mode on, accept edits on, plan mode on, auto mode on',
      '', '─'.repeat(80), '❯ ',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]
    expect(modeOf(quoting, claude)?.id).toBe('auto')
    const onlyQuoted = [
      'plan mode on is what I would use here',
      '', '', '', '', '', '', '', '',
      '❯ ', '  ? for shortcuts',
    ]
    expect(modeOf(onlyQuoted, claude)).toBeNull()
  })

  it('a frame with no footer yet is NULL, never a guess', () => {
    // A chip naming the wrong mode is worse than no chip: it is read at a glance and believed.
    expect(modeOf(['starting up…'], claude)).toBeNull()
    expect(modeOf([], claude)).toBeNull()
  })

  it('an unprobed harness has no spec and therefore no mode', () => {
    for (const h of ['codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const) {
      expect(MODE_SPECS[h]).toBeNull()
      expect(modeOf(frameWith(FOOTERS.auto), modeSpecFor(h))).toBeNull()
    }
    expect(modeOf(frameWith(FOOTERS.auto), undefined)).toBeNull()
  })

  it('the cycle key is the one that was driven', () => {
    expect(claude?.cycleKey).toBe('BTab')
    expect(claude?.probed).toContain('2.1.263')
  })
})

describe('MODE.NOQ — bypass permissions ("no questions")', () => {
  it('is read off the footer and means no-questions', () => {
    expect(modeOf(frameWith(FOOTERS.bypass), claude)?.id).toBe('bypass')
    expect(canonicalOfTuiMode('bypass')).toBe('no-questions')
    // auto (the classifier mode) still means none of the four
    expect(canonicalOfTuiMode('auto')).toBeUndefined()
  })

  it('sits between plan and auto, as measured', () => {
    expect(claude!.modes.map(m => m.id)).toEqual(['manual', 'accept-edits', 'plan', 'bypass', 'auto'])
  })
})

/** A fake terminal whose cycle is `cycle`; the footer moves one step per key. */
function fakeTerminal(cycle: string[], start: string, opts: { failSend?: boolean; blank?: boolean } = {}) {
  let at = cycle.indexOf(start)
  const sent: string[] = []
  return {
    sent,
    now: () => cycle[at],
    io: {
      sendKey: async (key: string) => { if (opts.failSend) return false; sent.push(key); at = (at + 1) % cycle.length; return true },
      readMode: async () => (opts.blank ? null : cycle[at]!),
      sleep: async () => {},
    },
  }
}
const spec = claude as ModeSpec
const FIVE = ['manual', 'accept-edits', 'plan', 'bypass', 'auto']
const FOUR = ['manual', 'accept-edits', 'plan', 'auto']

describe('cycleToMode', () => {
  it('presses until the footer names the target', async () => {
    const t = fakeTerminal(FIVE, 'manual')
    expect(await cycleToMode(spec, 'bypass', t.io)).toBe('reached')
    expect(t.sent).toHaveLength(3)
    expect(t.now()).toBe('bypass')
  })

  it('a session started WITHOUT the allow flag: bypass is unreachable and the mode is left where it was', async () => {
    const t = fakeTerminal(FOUR, 'plan')
    expect(await cycleToMode(spec, 'bypass', t.io)).toBe('unreachable')
    expect(t.now()).toBe('plan')
  })

  it('reads instead of counting: auto from manual lands on auto in both cycles', async () => {
    for (const cycle of [FIVE, FOUR]) {
      const t = fakeTerminal(cycle, 'manual')
      expect(await cycleToMode(spec, 'auto', t.io)).toBe('reached')
      expect(t.now()).toBe('auto')
    }
  })

  it('already there: no key at all', async () => {
    const t = fakeTerminal(FIVE, 'plan')
    expect(await cycleToMode(spec, 'plan', t.io)).toBe('reached')
    expect(t.sent).toHaveLength(0)
  })

  it('no footer: unread, nothing sent; a failed send says so', async () => {
    const blank = fakeTerminal(FIVE, 'manual', { blank: true })
    expect(await cycleToMode(spec, 'plan', blank.io)).toBe('unread')
    expect(blank.sent).toHaveLength(0)
    expect(await cycleToMode(spec, 'plan', fakeTerminal(FIVE, 'manual', { failSend: true }).io)).toBe('send-failed')
  })

  it('a target the table does not know is refused before any key', async () => {
    const t = fakeTerminal(FIVE, 'manual')
    expect(await cycleToMode(spec, 'nope', t.io)).toBe('unreachable')
    expect(t.sent).toHaveLength(0)
  })
})
