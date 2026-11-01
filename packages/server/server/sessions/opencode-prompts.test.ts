/**
 * opencode 1.19.5's TUI, read from REAL frames — every fixture under `fixtures/opencode-1.19.5/` is a
 * `tmux capture-pane -p` (or `-e -p` for `.ansi`) of a throwaway opencode session, captured 2026-10-31
 * (leader/qa/opencode-wp-a-probe). Only the throwaway's path was shortened to `/tmp/scratch`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attentionOf } from './attention'
import { rulesFor } from './attention-rules'
import { approvalFor, canPick, markerReadOptions } from './approval-spec'
import { readDialog } from './dialog-choice'
import { inlineSteps, readInlineOptions, readInlineSelected } from './inline-select'

const NOW = 1_793_410_000_000
const read = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'opencode-1.19.5', name), 'utf8').split('\n')
const stateOf = (lines: string[], moving = false) => attentionOf({
  alive: true, lastActivityMs: moving ? NOW : NOW - 30_000, nowMs: NOW, frame: lines,
  frameDigest: moving ? 'b' : 'same', prevDigest: moving ? 'a' : 'same', rules: rulesFor('opencode')!,
})
const spec = approvalFor('opencode')!

describe('opencode attention', () => {
  it('a permission prompt (shell and edit) and a question are a person being asked', () => {
    for (const f of ['permission-bash.txt', 'permission-edit.txt', 'question.txt', 'question-multi.txt']) {
      expect(stateOf(read(f)), f).toBe('waiting-approval')
    }
  })
  it('the running footer (`esc interrupt`) is work, even on a still frame', () => {
    expect(stateOf(read('working.txt'))).toBe('working')
    expect(stateOf(read('working-command.txt'), true)).toBe('working')
  })
  it('the idle and start screens are not a dialog', () => {
    expect(stateOf(read('idle.txt'))).not.toBe('waiting-approval')
    expect(stateOf(read('start.txt'))).not.toBe('waiting-approval')
  })
})

describe('opencode permission row (side by side, colour highlight)', () => {
  it('reads its three options off the plain frame, and says how they are picked', () => {
    for (const f of ['permission-bash.txt', 'permission-edit.txt']) {
      const d = readDialog(read(f), markerReadOptions('opencode'))
      expect(d.kind).toBe('options')
      expect(d.select).toBe('inline')
      expect(d.options.map(o => o.label)).toEqual(['Allow once', 'Allow always', 'Reject'])
    }
    expect(canPick(spec, 'inline')).toBe(true)
  })
  it('is never looked for on another harness', () => {
    expect(readDialog(read('permission-bash.txt'), markerReadOptions('claude')).select).not.toBe('inline')
  })
  it('the highlight is read off the ANSI capture, at each step of a Right cycle', () => {
    const labels = readInlineOptions(read('permission-bash.txt'), spec.inlineSelect!)!
    expect(readInlineSelected(read('permission-p1-initial.ansi'), spec.inlineSelect!, labels)).toBe(0)
    expect(readInlineSelected(read('permission-p2-right1.ansi'), spec.inlineSelect!, labels)).toBe(1)
    expect(readInlineSelected(read('permission-p3-right2.ansi'), spec.inlineSelect!, labels)).toBe(2)
  })
  it('a plain frame says nothing about the highlight, so it is refused rather than guessed', () => {
    expect(readInlineSelected(read('permission-bash.txt'), spec.inlineSelect!, ['Allow once', 'Allow always', 'Reject'])).toBeNull()
  })
  it('walks the ring forward', () => {
    expect(inlineSteps(0, 2, 3)).toBe(2)
    expect(inlineSteps(2, 0, 3)).toBe(1)
    expect(inlineSteps(1, 1, 3)).toBe(0)
  })
})

describe('opencode question', () => {
  it('its numbered options are read through the left bar, and a numbered pick stays refused (no measured digit)', () => {
    const d = readDialog(read('question.txt'), markerReadOptions('opencode'))
    expect(d.select).toBe('numbered')
    expect(d.options.map(o => o.label)).toEqual(['Red', 'Green', 'Blue', 'Type your own answer'])
    expect(canPick(spec, 'numbered')).toBe(false)
  })
})
