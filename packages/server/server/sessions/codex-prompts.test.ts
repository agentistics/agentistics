/**
 * codex 0.160.1's blocking prompts, read from REAL frames.
 *
 * Every fixture under `fixtures/codex-0.160.1/` is a `tmux capture-pane -p` of a throwaway codex
 * 0.160.1 session (own CODEX_HOME, `approval_policy = "on-request"`, `sandbox_mode = "read-only"`),
 * captured 2026-10-07. Only the scratch directory's path was shortened to `/tmp/scratch`, which is
 * why the patch prompt's destination still wraps where the longer path did.
 *
 * The bug these pin: the only codex approval rule was `Press enter to continue` (codex 0.113.0's
 * update picker). 0.160.1's command / patch / network prompts end in `Press enter to confirm or esc
 * to cancel`, its startup daemon-settings prompt uses the same confirmation footer, and its trust
 * prompt in `enter continue · esc back`, so every one of them read as
 * `waiting` — the terminal showed the question and the chat had no card to answer it with.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attentionOf } from './attention'
import { rulesFor } from './attention-rules'
import { approvalFor, choiceKey } from './approval-spec'
import { markerReadOptions } from './approval-spec'
import { readDialog } from './dialog-choice'
import { answerFollowUp } from './answer-followup'

const NOW = 1_786_600_000_000
const frame = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'codex-0.160.1', `${name}.txt`), 'utf8').split('\n')

const quiet = (lines: string[]) => {
  const rules = rulesFor('codex')
  return attentionOf({
    alive: true,
    lastActivityMs: NOW - 30_000,
    nowMs: NOW,
    frame: lines,
    frameDigest: 'same',
    prevDigest: 'same',
    ...(rules ? { rules } : {}),
  })
}

const PROMPTS = {
  exec: [
    'Yes, proceed (y)',
    "Yes, and don't ask again for commands that start with `touch b.txt` (p)",
    'No, and tell Codex what to do differently (esc)',
  ],
  network: [
    'Yes, proceed (y)',
    "Yes, and don't ask again for commands that start with `curl -sI https://example.com` (p)",
    'No, and tell Codex what to do differently (esc)',
  ],
  patch: [
    'Yes, proceed (y)',
    "Yes, and don't ask again for these files (a)",
    'No, and tell Codex what to do differently (esc)',
  ],
  trust: ['Trust and continue', 'Back to Agent Command Center'],
  'startup-daemon': ['Run without daemon this time', 'Restart with these settings', 'Cancel'],
} as const

describe('codex 0.160.1 — every blocking prompt is seen, and its options read', () => {
  for (const [kind, labels] of Object.entries(PROMPTS)) {
    it(`${kind}: waiting-approval`, () => {
      expect(quiet(frame(kind))).toBe('waiting-approval')
    })

    it(`${kind}: the real numbered options, option 1 highlighted`, () => {
      const read = readDialog(frame(kind), markerReadOptions('codex'))
      expect(read.kind).toBe('options')
      expect(read.select).toBe('numbered')
      expect(read.options.map(o => o.label)).toEqual([...labels])
      expect(read.options.map(o => o.selected)).toEqual(labels.map((_, i) => i === 0))
    })
  }

  it('an idle codex is waiting, never waiting-approval', () => {
    expect(quiet(frame('idle'))).toBe('waiting')
    expect(readDialog(frame('idle')).kind).toBe('none')
  })

  it('answers by digit — measured: `3` declined the command prompt, `1` approved it', () => {
    const spec = approvalFor('codex')
    expect(choiceKey(spec, 1)).toBe('1')
    expect(choiceKey(spec, 3)).toBe('3')
  })

  /**
   * Measured on the trust prompt: a digit naming the row that is ALREADY highlighted does nothing
   * (`2` picked "Back to Agent Command Center" outright, `1` left the prompt up). `answerFollowUp`
   * is what turns that into the Enter that finishes it — same dialog, our row highlighted.
   */
  it('trust prompt: a no-op `1` is finished by Enter, never left stuck', () => {
    const before = readDialog(frame('trust')).options
    expect(answerFollowUp({ stillAsking: true, before, after: before, choice: 1 })).toEqual({ kind: 'submit' })
  })
})
