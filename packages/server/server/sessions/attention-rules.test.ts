import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { ATTENTION_RULES, rulesFor } from './attention-rules'
import { attentionOf } from './attention'

const NOW = 1_786_600_000_000

/** Quiet and unmoving, so only the frame decides. */
const quiet = (frame: string[], harness: 'claude' | 'codex' | 'kimi' | 'gemini' | 'copilot' | 'antigravity') => {
  const rules = rulesFor(harness)
  return attentionOf({
    alive: true,
    // Past QUIET_MS so movement cannot fire, but INSIDE `MARKER_STALE_MS` so a probed marker is
    // still trusted: these tests are about what the frame says, not about staleness.
    lastActivityMs: NOW - 30_000,
    nowMs: NOW,
    frame,
    frameDigest: 'same',
    prevDigest: 'same',
    ...(rules ? { rules } : {}),
  })
}

// ── Frames below are VERBATIM from real sessions, 2026-08-13. ────────────────────────────────────

/** claude 2.1.231 — the folder-trust dialog it opens with, which is the select component every
 *  blocking question uses. */
const CLAUDE_APPROVAL = [
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
]

/**
 * claude 2.1.232, 2026-08-14 — the PERMISSION prompt, verbatim from a live session.
 *
 * A DIFFERENT component from the folder-trust dialog above, with a different footer, and the rule
 * probed from that one does not match it. Measured the hard way: this exact frame reported
 * `waiting`, and the prompt then typed into the session went into the dialog's own filter, where
 * the submit took the highlighted option and approved a shell command nobody had read.
 */
const CLAUDE_BASH_PERMISSION = [
  ' Bash command',
  '',
  '   env | head -3',
  '   Show first 3 environment variables',
  '',
  ' This command requires approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for: env',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
]

/**
 * claude 2.1.232, 2026-08-14 — the same component asking about a FILE, verbatim.
 *
 * The second capture is what makes the matched text the component's footer rather than one dialog's
 * wording: this one offers no `ctrl+e to explain`, because there is no command to explain.
 */
const CLAUDE_WRITE_PERMISSION = [
  ' Create file',
  ' agentop-write-probe.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 hello',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create agentop-write-probe.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
]

/** claude 2.1.231 — mid-turn. Note the input box is drawn EXACTLY as it is when idle. */
const CLAUDE_WORKING = [
  '✢ Orbiting… (5s · ↓ 76 tokens)',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏸ manual mode on · esc to interrupt · ← 6 agents                                              /rc',
]

/** claude 2.1.231 — turn finished. Only the footer differs from CLAUDE_WORKING. */
const CLAUDE_IDLE = [
  '✻ Cooked for 7s',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← 6 agents                                               /rc',
]

/** codex 0.113.0 — the update dialog, its one blocking question. */
const CODEX_APPROVAL = [
  '› 1. Update now (runs `bun install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
]

/** codex 0.113.0 — idle. Byte-identical to its mid-stream frame apart from the transcript above. */
const CODEX_IDLE = [
  '› Find and fix a bug in @filename',
  '',
  '  gpt-5.4-mini low · 100% left · /tmp/scratchpad',
]

/** kimi 0.35.0 — the folder-trust dialog. */
const KIMI_APPROVAL = [
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '   ❯ Trust this folder',
  "     Don't trust",
]

// ── kimi 2.1.1 — verbatim from a real TUI under tmux, 2026-10-09 (throwaway KIMI_CODE_HOME, mock model). ──
// The folder-trust dialog GREW: its footer is now under the title, ~14 rows above the bottom, where the
// 4-row footer window cannot see it.
const KIMI_211_TRUST = [
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp/qa/work',
  '  chpad/work5',
  '',
  '  Project-level MCP servers are disabled until you explicitly choose Trust. Trust starts the listed project MCP',
  '  targets and remembers this folder.',
  '',
  '   ❯ Trust this folder',
  '     Enable project MCP servers. Remembered for this folder.',
  '',
  "     Don't trust",
  '     Exit Kimi Code. Asked again next launch.',
  '',
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
]

/** A tool approval — numbered `▶ 1. Approve once … 4. Reject with feedback`. */
const KIMI_211_TOOL = [
  ' ✨ please run TOOL',
  '',
  ' ● Running a command · $ pwd',
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '   ▶ Run this command?',
  '',
  '   cwd: /tmp/qa/work',
  '   $ pwd',
  '     print cwd',
  '',
  '   ▶ 1. Approve once',
  '     2. Approve for this session',
  '     3. Reject',
  '     4. Reject with feedback',
  '',
  '   ↑/↓ select · 1/2/3/4 choose · ↵ confirm',
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' mock  …/4d5647da-07a4-41c0-8001-f360f5d32874/scratchpad/work4                                            ctrl+o expand',
  '                                                                                                   context: 1% (15/32k)',
]

/** AskUserQuestion — `→ [1] red … [4] Other`. */
const KIMI_211_ASK = [
  ' ✨ please ASK me',
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  question',
  '',
  '   Colour    Submit',
  '',
  '  ? Which colour?',
  '',
  '   → [1] red',
  '         warm',
  '     [2] green',
  '         calm',
  '     [3] blue',
  '         cool',
  '     [4] Other',
  '',
  '   ↑↓ select  1-4 / ↵ choose  ←/→/tab switch  esc cancel',
  ' ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' mock  …/4d5647da-07a4-41c0-8001-f360f5d32874/scratchpad/work4                                            ctrl+o expand',
  '                                                                                                   context: 1% (15/32k)',
]

/** The same screen once the dialog is gone: the input box, its status line. */
const KIMI_211_IDLE = [
  '',
  ' ● done after tool: Wall time: 0.015 seconds',
  ' ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ >                                                                                                                  │',
  ' ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  ' mock  …/work4                                                                                        ctrl+o expand',
  '                                                                                                   context: 1% (15/32k)',
]

describe('ATTENTION_RULES', () => {
  it('declares an entry for every harness, so a new one cannot be forgotten', () => {
    for (const h of HARNESS_ORDER) {
      expect(ATTENTION_RULES).toHaveProperty(h)
    }
  })

  it('never uses the g flag, which would make .test() alternate', () => {
    for (const h of HARNESS_ORDER) {
      const r = ATTENTION_RULES[h]
      if (!r) continue
      for (const re of [...r.approval, ...(r.working ?? [])]) {
        expect(re.global).toBe(false)
      }
    }
  })

  it('records provenance for every harness that has rules', () => {
    for (const h of HARNESS_ORDER) {
      const r = ATTENTION_RULES[h]
      if (!r) continue
      expect(r.probed).toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })
})

describe('claude', () => {
  it('sees the blocking dialog', () => {
    expect(quiet(CLAUDE_APPROVAL, 'claude')).toBe('waiting-approval')
  })

  it('sees the PERMISSION prompt, which is a different component with a different footer', () => {
    // The bug this replaced: the rule was probed from the folder-trust dialog alone, so the one
    // dialog people actually meet — "may I run this command" — read as `waiting`. It was not merely
    // a wrong label: with the block invisible, typing a prompt into that session put the text into
    // the dialog's filter and submitted it, taking the highlighted option.
    expect(quiet(CLAUDE_BASH_PERMISSION, 'claude')).toBe('waiting-approval')
    expect(quiet(CLAUDE_WRITE_PERMISSION, 'claude')).toBe('waiting-approval')
  })

  it('keys on the part BOTH permission dialogs share', () => {
    // `ctrl+e to explain` is offered only where there is a command to explain, so a rule keyed on it
    // would have gone on missing every file edit — the same class of miss all over again.
    const rules = rulesFor('claude')!
    const hits = (frame: string[]) =>
      rules.approval.filter(re => re.test(frame.join('\n'))).length
    expect(hits(CLAUDE_BASH_PERMISSION)).toBe(1)
    expect(hits(CLAUDE_WRITE_PERMISSION)).toBe(1)
  })

  it('does not call a working turn blocked, now that there are two approval patterns', () => {
    // A second pattern is a second chance to match something that is not a dialog.
    expect(quiet(CLAUDE_WORKING, 'claude')).toBe('working')
    expect(quiet(CLAUDE_IDLE, 'claude')).toBe('waiting')
  })

  it('sees a running turn from the footer, not from the input box', () => {
    expect(quiet(CLAUDE_WORKING, 'claude')).toBe('working')
  })

  it('reports a finished turn as waiting', () => {
    expect(quiet(CLAUDE_IDLE, 'claude')).toBe('waiting')
  })
})

describe('codex', () => {
  it('sees the blocking dialog', () => {
    expect(quiet(CODEX_APPROVAL, 'codex')).toBe('waiting-approval')
  })

  it('has no working marker — its idle and streaming frames are the same', () => {
    expect(rulesFor('codex')?.working).toBeUndefined()
    expect(quiet(CODEX_IDLE, 'codex')).toBe('waiting')
  })
})

describe('kimi', () => {
  it('sees the blocking dialog', () => {
    expect(quiet(KIMI_APPROVAL, 'kimi')).toBe('waiting-approval')
  })
  it('2.1.1: sees all THREE of its blocking dialogs, each with a footer in a different place', () => {
    expect(quiet(KIMI_211_TRUST, 'kimi')).toBe('waiting-approval')
    expect(quiet(KIMI_211_TOOL, 'kimi')).toBe('waiting-approval')
    expect(quiet(KIMI_211_ASK, 'kimi')).toBe('waiting-approval')
  })
  it('2.1.1: the same screen once the dialog is gone is just waiting', () => {
    expect(quiet(KIMI_211_IDLE, 'kimi')).toBe('waiting')
  })
  it('2.1.1: a session that merely QUOTES a footer high up in its transcript is not blocked', () => {
    const quoting = [' ● the rule is /↑\\/↓ select · [\\d/]+ choose · ↵ confirm/ in attention-rules.ts', ' Exit Kimi Code. Asked again next launch.', ...Array(8).fill(' ...'), ...KIMI_211_IDLE]
    expect(quiet(quoting, 'kimi')).toBe('waiting')
  })
})

/** gemini 0.55.1 — an authentication confirmation, the same select its trust prompt uses. */
const GEMINI_APPROVAL = [
  '│  Do you want to continue?                                                    │',
  '│  ● 1. Yes                                                                    │',
  '│    2. No                                                                     │',
  '│  Enter to select · ↑/↓ to navigate · Esc to cancel                           │',
]

/** GitHub Copilot CLI 1.0.79 — the folder-trust dialog. */
const COPILOT_APPROVAL = [
  '│ Do you trust the files in this folder?                                       │',
  '│ ❯ 1. Yes                                                                     │',
  '│ ↑/↓ to navigate · enter to select · esc to cancel                            │',
]

/** agy 1.1.12 — the folder-trust dialog. Note the different wording. */
const AGY_APPROVAL = [
  'Do you trust the contents of this project?',
  '> Yes, I trust this folder',
  '  No, exit',
  '  ↑/↓ Navigate · enter Confirm',
]

describe('the harnesses probed alongside their spawn specs', () => {
  it('sees a gemini blocking dialog', () => {
    expect(quiet(GEMINI_APPROVAL, 'gemini')).toBe('waiting-approval')
  })

  it('sees a copilot blocking dialog', () => {
    expect(quiet(COPILOT_APPROVAL, 'copilot')).toBe('waiting-approval')
  })

  it('sees an agy blocking dialog', () => {
    expect(quiet(AGY_APPROVAL, 'antigravity')).toBe('waiting-approval')
  })

  it('does not let one harness pattern answer for another', () => {
    // agy words its footer `↑/↓ Navigate · enter Confirm` while copilot writes
    // `↑/↓ to navigate · enter to select`. One shared guess would have matched neither exactly, and
    // a pattern loose enough to match both would fire on any list with arrow-key help on it.
    expect(quiet(AGY_APPROVAL, 'copilot')).toBe('waiting')
    expect(quiet(COPILOT_APPROVAL, 'antigravity')).toBe('waiting')
  })

  it('lets claude and gemini overlap, because they MEASURABLY share that footer', () => {
    // `GEMINI_APPROVAL` used to be asserted alongside the two above, and that was right until
    // claude's THIRD dialog was probed on 2026-08-14: its `AskUserQuestion` footer really does read
    // `Enter to select · ↑/↓ to navigate · Esc to cancel`, which is gemini's line exactly.
    //
    // So the overlap is a FACT about the two CLIs rather than a pattern written too loosely, and it
    // costs nothing: `rulesFor(harness)` only ever tests a harness's own rules against its own
    // frames, so neither is ever asked about the other outside this test. What the rule above still
    // protects is the thing that mattered — nobody writing ONE pattern to cover several harnesses
    // in place of probing each of them.
    expect(quiet(GEMINI_APPROVAL, 'claude')).toBe('waiting-approval')
    expect(quiet(GEMINI_APPROVAL, 'gemini')).toBe('waiting-approval')
  })
})
