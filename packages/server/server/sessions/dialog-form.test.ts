/**
 * Trust prompts and multi-question / multi-select forms, read off REAL frames.
 *
 * Every frame below was captured on 2026-10-23 by starting the CLI under a private tmux socket and
 * reading `capture-pane -p` (trailing blank rows trimmed, as the poller does). Versions: claude
 * 2.1.309, agy 1.4.6, GitHub Copilot CLI 1.0.98, kimi 2.2.0, codex 0.161.0. The keys the specs
 * name (digits, Down/Up, Right/Left) were driven against the same live sessions.
 */
import { describe, expect, it } from 'bun:test'
import { readDialog } from './dialog-choice'
import { attentionOf, dialogOnScreen, headedMenuOpen } from './attention'
import { rulesFor } from './attention-rules'
import { approvalFor, isFreeTextOption, markerReadOptions } from './approval-spec'
import { promptIsBlocked } from './prompt-guard'
import type { HarnessId } from '@agentistics/core'

const NOW = 1_786_600_000_000
const quiet = { alive: true, lastActivityMs: NOW - 60_000, nowMs: NOW, frameDigest: 'x', prevDigest: 'x' }
const stateOf = (harness: HarnessId, frame: string[]) =>
  attentionOf({ ...quiet, frame, rules: rulesFor(harness)! })

const RULE = '─'.repeat(118)

/** claude: step 1 of a two-question AskUserQuestion, a MULTI-SELECT, with Apple already ticked. */
const CLAUDE_MULTI = [
  '❯ Use the AskUserQuestion tool ONCE with exactly 2 questions',
  RULE,
  '←  ☒ Fruit  ☐ Color  ✔ Submit  →',
  '',
  'Which fruits?',
  '',
  '❯ 1. [✔] Apple',
  '         Apple fruit',
  '  2. [ ] Banana',
  '         Banana fruit',
  '  3. [ ] Cherry',
  '         Cherry fruit',
  '  4. [ ] Type something',
  '     Next',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
]

/** claude: step 2, single choice. */
const CLAUDE_SINGLE = [
  RULE,
  '←  ☒ Fruit  ☐ Color  ✔ Submit  →',
  '',
  'Which color?',
  '',
  '❯ 1. Red',
  '     Red color',
  '  2. Blue',
  '     Blue color',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
]

/** claude: the REVIEW step — note there is NO footer below `2. Cancel`. */
const CLAUDE_REVIEW = [
  RULE,
  '←  ☒ Fruit  ☒ Color  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● Which fruits?',
  '   → Apple, Cherry',
  ' ● Which color?',
  '   → Blue',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
]

/** agy: question 1 of 2, multi-select, after `1` then `3`. */
const AGY_MULTI = [
  '? Which fruits?',
  '? Which color?',
  'Question',
  RULE,
  'Question 1/2: Which fruits?',
  '  1. [x] Apple',
  '  2. [ ] Banana',
  '> 3. [x] Cherry',
  '  4. Write-in...',
  '  ↑/↓ Navigate · → Next · space Toggle · enter Submit · esc Skip',
  'esc to cancel                                                                                  Gemini 3.6 Flash · medium',
]

/** agy: the last question, single choice. */
const AGY_LAST = [
  'Question',
  RULE,
  'Question 2/2: Which color?',
  '> 1. Red',
  '  2. Blue',
  '  3. Write-in...',
  '  ↑/↓ Navigate · ← Back · enter Submit All · esc Skip',
  'esc to cancel                                                                                  Gemini 3.6 Flash · medium',
]

/** agy: a one-question single choice (its footer differs again). */
const AGY_ONE = [
  'Question',
  RULE,
  'Question 1/1: Pick a fruit',
  '> 1. Apple',
  '  2. Banana',
  '  3. Write-in...',
  '  ↑/↓ Navigate · enter Select · esc Skip',
  'esc to cancel                                                                                  Gemini 3.6 Flash · medium',
]

/** agy: `3` on Write-in opened its field. */
const AGY_FIELD = [
  'Question 1/1: Pick a fruit',
  '  1. Apple',
  '  2. Banana',
  '> 3. Write-in...',
  '  Your answer:',
  '  enter Submit · esc Back',
  'esc to cancel                                                                                  Gemini 3.6 Flash · medium',
]

/** copilot: its folder-trust dialog, drawn INSIDE a box. */
const BOX = (t: string) => `│ ${t.padEnd(116)} │`
const COPILOT_TRUST = [
  ' ● Tip: /copy',
  `╭${'─'.repeat(118)}╮`,
  BOX('Confirm folder trust'),
  BOX('─'.repeat(116)),
  BOX('Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will'),
  BOX('remember your permissions for the rest of this session.'),
  BOX(''),
  BOX('Do you trust the files in this folder?'),
  BOX(''),
  BOX('❯ 1. Yes'),
  BOX('  2. Yes, and remember this folder for future sessions'),
  BOX('  3. No (Esc)'),
  BOX(''),
  BOX('↑/↓ to navigate · enter to select · esc to cancel'),
  `╰${'─'.repeat(118)}╯`,
]

/** kimi 2.2.0: folder trust, numberless, its `↑↓ navigate` line under the TITLE. */
const KIMI_TRUST = [
  ` ${RULE}`,
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp/probe/kimi2',
  '',
  '  No project integrations or instructions to activate.',
  '',
  '  Trust is remembered for this folder, including future project config changes.',
  '  Tool approvals follow your permission settings.',
  '',
  '   ❯ Trust and continue',
  '     Exit',
  ` ${RULE}`,
]

/** codex 0.161.0: the startup update picker. */
const CODEX_UPDATE = [
  '  Update available · 0.161.0 → 0.163.0',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `bun install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  enter continue · esc skip',
]

describe('a multi-select step reads as CHECKBOXES, and its form around it', () => {
  it('claude: the box is stripped from the label and its state kept', () => {
    const d = readDialog(CLAUDE_MULTI, markerReadOptions('claude'))
    expect(d.kind).toBe('options')
    expect(d.options.map(o => [o.label, o.checked])).toEqual([
      ['Apple', true], ['Banana', false], ['Cherry', false], ['Type something', false], ['Chat about this', undefined],
    ])
    expect(d.form).toEqual({ multi: true, steps: [{ label: 'Fruit', done: true }, { label: 'Color', done: false }] })
    // Stripped, the write-your-own box is still the write-your-own option.
    expect(isFreeTextOption('claude', d.options[3]!.label)).toBe(true)
  })

  it('agy: the same, with `[x]`, its `Question n/m`, and Write-in as a field', () => {
    const d = readDialog(AGY_MULTI, markerReadOptions('antigravity'))
    expect(d.options.map(o => [o.label, o.checked])).toEqual([
      ['Apple', true], ['Banana', false], ['Cherry', true], ['Write-in...', undefined],
    ])
    expect(d.form).toEqual({ multi: true, position: { at: 1, of: 2 } })
    expect(isFreeTextOption('antigravity', 'Write-in...')).toBe(true)
  })

  it('a single-choice step carries the form but no boxes', () => {
    const d = readDialog(CLAUDE_SINGLE)
    expect(d.options.every(o => o.checked === undefined)).toBe(true)
    expect(d.form).toEqual({ steps: [{ label: 'Fruit', done: true }, { label: 'Color', done: false }] })
    expect(readDialog(AGY_LAST).form).toEqual({ position: { at: 2, of: 2 } })
  })

  it('a plain question has no form at all', () => {
    expect(readDialog(['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel · Tab to amend']).form).toBeUndefined()
  })
})

describe('the REVIEW step has no footer and still reads as a question', () => {
  it('is read as the review, with its two options', () => {
    const d = readDialog(CLAUDE_REVIEW)
    expect(d.options.map(o => o.label)).toEqual(['Submit answers', 'Cancel'])
    expect(d.form?.review).toBe(true)
  })

  it('is waiting-approval, so the card stays and the composer is refused', () => {
    expect(stateOf('claude', CLAUDE_REVIEW)).toBe('waiting-approval')
    expect(dialogOnScreen(rulesFor('claude')!, CLAUDE_REVIEW)).toBe(true)
    expect(promptIsBlocked('claude', CLAUDE_REVIEW)).toBe(true)
  })

  it('the sentence QUOTED away from a menu does not count', () => {
    const quoted = ['Ready to submit your answers?', 'some reply text', '1. first point', '2. second point']
    expect(headedMenuOpen(rulesFor('claude')!, quoted)).toBe(false)
    expect(stateOf('claude', ['notes:', 'Ready to submit your answers? is what it prints', '', '❯ '])).toBe('waiting')
  })
})

describe('every harness that asks is SEEN asking', () => {
  const cases: [HarnessId, string, string[]][] = [
    ['claude', 'multi-select step', CLAUDE_MULTI],
    ['claude', 'review step', CLAUDE_REVIEW],
    ['antigravity', 'multi-select step', AGY_MULTI],
    ['antigravity', 'last step', AGY_LAST],
    ['antigravity', 'one question', AGY_ONE],
    ['antigravity', 'write-in field', AGY_FIELD],
    ['copilot', 'boxed folder trust', COPILOT_TRUST],
    ['kimi', 'folder trust (2.2.0)', KIMI_TRUST],
    ['codex', 'update picker', CODEX_UPDATE],
  ]
  for (const [harness, what, frame] of cases) {
    it(`${harness}: ${what}`, () => {
      expect(stateOf(harness, frame)).toBe('waiting-approval')
      expect(promptIsBlocked(harness, frame)).toBe(true)
    })
  }
})

/**
 * kimi 0.41.0 / 2.1.1's GROUPED trust prompt (captured 2026-09-08, `dialog-marker.test.ts`), with its
 * last description changed: the old rule keyed on that sentence, so any other wording — and a MOVING
 * frame — read the session as working (board KIMI.TRUST). The header above the block decides now.
 */
const KIMI_GROUPED = [
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp/agkimi-wAb8iS',
  '',
  '  Project-level MCP servers are disabled until you explicitly choose Trust. Trust starts the',
  '  listed project MCP targets and remembers this folder.',
  '',
  '   ❯ Trust this folder',
  '     Enable project MCP servers. Remembered for this folder.',
  '',
  "     Don't trust",
  '     Quit now.',
]

describe('kimi: the grouped trust prompt (2.1.1 shape)', () => {
  it('is waiting-approval even while the frame moves', () => {
    expect(attentionOf({ ...quiet, prevDigest: 'a', frameDigest: 'b', frame: KIMI_GROUPED, rules: rulesFor('kimi')! }))
      .toBe('waiting-approval')
  })
  it('is read by its groups and answerable by moving', () => {
    const d = readDialog(KIMI_GROUPED, markerReadOptions('kimi'))
    expect(d.options.map(o => [o.label, o.selected])).toEqual([['Trust this folder', true], ["Don't trust", false]])
  })
})

describe('trust prompts are READ, so the card can answer them', () => {
  it('copilot: the boxed options are read and picked by digit', () => {
    const d = readDialog(COPILOT_TRUST, markerReadOptions('copilot'))
    expect(d.kind).toBe('options')
    expect(d.options.map(o => o.label)).toEqual(['Yes', 'Yes, and remember this folder for future sessions', 'No (Esc)'])
    expect(d.options[0]!.selected).toBe(true)
    expect(approvalFor('copilot')?.choice?.kind).toBe('digit')
  })

  it('kimi: the numberless rows are read and reached by moving', () => {
    const d = readDialog(KIMI_TRUST, markerReadOptions('kimi'))
    expect(d.select).toBe('marker')
    expect(d.options.map(o => [o.label, o.selected])).toEqual([['Trust and continue', true], ['Exit', false]])
    expect(approvalFor('kimi')?.move).toBeDefined()
  })

  it('codex: the update picker is read with its `›` cursor', () => {
    expect(readDialog(CODEX_UPDATE).options.map(o => o.label)).toEqual([
      'Update now (runs `bun install -g @openai/codex`)', 'Skip', 'Skip until next version',
    ])
  })

  it('a box border alone does not make prose a menu', () => {
    expect(readDialog(['│ see 1. above │', '│ and 2. below │']).kind).toBe('none')
    // ...and only a line bordered on BOTH sides is unwrapped: a single bar is text.
    expect(readDialog(['│ 1. one', '│ 2. two']).kind).toBe('none')
  })
})

describe('step keys exist only where a form was driven', () => {
  it('claude and agy have them; nobody else does', () => {
    expect(approvalFor('claude')?.steps).toEqual(expect.objectContaining({ next: 'Right', back: 'Left' }))
    expect(approvalFor('antigravity')?.steps).toEqual(expect.objectContaining({ next: 'Right', back: 'Left' }))
    for (const h of ['codex', 'gemini', 'copilot', 'kimi'] as const) expect(approvalFor(h)?.steps).toBeUndefined()
  })
})
