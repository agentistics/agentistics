/**
 * `subtaskStats` — the same evidence numbers `taskStats` computes for a whole delivery, re-partitioned
 * per subtask (or the "direct" branch). See docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md
 * §C.5, and the doc comment on `subtaskStats` itself for the full design.
 */

import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { subtaskStats, taskStats } from './task-stats'
import type { ManagedSession } from './types'

const row = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  id: 'r1', harness: 'claude', cwd: '/repo', createdAt: '2026-09-05T10:00:00.000Z',
  taskId: 't1', conversationId: 'c1',
  ...over,
} as ManagedSession)

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 'c1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude', model: 'claude-sonnet-5',
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
  files_modified: 3, lines_added: 20, lines_removed: 5, git_commits: 1, tool_errors: 0,
  ...over,
} as SessionMeta)

const metasOf = (...ms: SessionMeta[]) =>
  new Map(ms.map(m => [m.session_id, m] as [string, SessionMeta]))

describe('subtaskStats', () => {
  it('returns null when nothing is filed under this subtask — never a stats block of empty fields', () => {
    // The subtask exists (it could be `todo`, freshly created), but no row names it: there is no
    // evidence block to draw at all, which is a different claim from "sessions are filed here but
    // reported nothing" (covered below).
    const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 'other' })]
    const result = subtaskStats({
      subtaskId: 's1', rows, metas: metasOf(meta()), createdAt: '2026-09-05T10:00:00.000Z',
    })
    expect(result).toBeNull()
  })

  it('returns null for the direct branch too, when every row is filed under some subtask', () => {
    const rows = [row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' })]
    const result = subtaskStats({
      subtaskId: null, rows, metas: metasOf(meta()), createdAt: '2026-09-05T10:00:00.000Z',
    })
    expect(result).toBeNull()
  })

  it('is a real, honest empty block (not null) when rows are filed but none resolve to a meta', () => {
    // "Filed but unmeasured" and "nothing filed" are different facts — only the second returns null.
    const rows = [row({ id: 'r1', conversationId: 'gone', subtaskId: 's1' })]
    const result = subtaskStats({
      subtaskId: 's1', rows, metas: metasOf(), createdAt: '2026-09-05T10:00:00.000Z',
    })
    expect(result).not.toBeNull()
    expect(result!.models).toEqual([])
    expect(result!.tokens).toBeNull()
    expect(result!.filesModified).toBeNull()
  })

  it('counts only the sessions filed under THIS subtask, never the whole task\'s rows', () => {
    const rows = [
      row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
      row({ id: 'r2', conversationId: 'c2', subtaskId: 's2' }),
    ]
    const metas = metasOf(
      meta({ session_id: 'c1', files_modified: 3, lines_added: 20, lines_removed: 5 }),
      meta({ session_id: 'c2', files_modified: 99, lines_added: 999, lines_removed: 999 }),
    )
    const result = subtaskStats({ subtaskId: 's1', rows, metas, createdAt: '2026-09-05T10:00:00.000Z' })
    expect(result).not.toBeNull()
    expect(result!.filesModified).toBe(3)
    expect(result!.linesAdded).toBe(20)
    expect(result!.linesRemoved).toBe(5)
  })

  it('the direct branch holds exactly the rows filed on the task itself, under no subtask', () => {
    const rows = [
      row({ id: 'r1', conversationId: 'c1' }), // direct
      row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }),
    ]
    const metas = metasOf(
      meta({ session_id: 'c1', files_modified: 3 }),
      meta({ session_id: 'c2', files_modified: 99 }),
    )
    const direct = subtaskStats({ subtaskId: null, rows, metas, createdAt: '2026-09-05T10:00:00.000Z' })
    expect(direct).not.toBeNull()
    expect(direct!.filesModified).toBe(3)
  })

  it('sums (subtasks + the direct branch) back to the task-wide taskStats total, no session in two buckets', () => {
    // The identical check `subtaskViews`'s three-shapes test already applies to the cost/session
    // rollup, applied here to the evidence numbers: every row falls into exactly one bucket, so
    // adding every bucket's numeric fields must reproduce the whole task's own `taskStats`.
    const rows = [
      row({ id: 'r1', conversationId: 'c1' }), // direct
      row({ id: 'r2', conversationId: 'c2' }), // direct
      row({ id: 'r3', conversationId: 'c3', subtaskId: 's1' }),
      row({ id: 'r4', conversationId: 'c4', subtaskId: 's2' }),
      row({ id: 'r5', conversationId: 'c5', subtaskId: 's2' }),
    ]
    const metas = metasOf(
      meta({ session_id: 'c1', files_modified: 5, lines_added: 10, lines_removed: 1, git_commits: 1 }),
      meta({ session_id: 'c2', files_modified: 2, lines_added: 3, lines_removed: 0, git_commits: 0 }),
      meta({ session_id: 'c3', files_modified: 7, lines_added: 40, lines_removed: 6, git_commits: 2 }),
      meta({ session_id: 'c4', files_modified: 11, lines_added: 1, lines_removed: 1, git_commits: 0 }),
      meta({ session_id: 'c5', files_modified: 1, lines_added: 1, lines_removed: 1, git_commits: 1 }),
    )
    const createdAt = '2026-09-05T10:00:00.000Z'

    const buckets = [
      subtaskStats({ subtaskId: null, rows, metas, createdAt }),
      subtaskStats({ subtaskId: 's1', rows, metas, createdAt }),
      subtaskStats({ subtaskId: 's2', rows, metas, createdAt }),
    ].filter((b): b is NonNullable<typeof b> => b !== null)

    // No bucket dropped and no session counted twice: three real buckets (direct, s1, s2).
    expect(buckets).toHaveLength(3)

    const sum = (field: 'filesModified' | 'linesAdded' | 'linesRemoved' | 'commits') =>
      buckets.reduce((a, b) => a + (b[field] ?? 0), 0)

    const whole = taskStats({
      metas: rows.map(r => metas.get(r.conversationId!)!),
      createdAt,
    })

    expect(sum('filesModified')).toBe(whole.filesModified ?? 0)
    expect(sum('linesAdded')).toBe(whole.linesAdded ?? 0)
    expect(sum('linesRemoved')).toBe(whole.linesRemoved ?? 0)
    expect(sum('commits')).toBe(whole.commits ?? 0)
    expect(whole.filesModified).toBe(26) // 5+2+7+11+1
  })

  it('a subtask with a subset of models/harnesses only ranks what its own rows reported', () => {
    const rows = [
      row({ id: 'r1', conversationId: 'c1', subtaskId: 's1' }),
      row({ id: 'r2', conversationId: 'c2', subtaskId: 's1' }),
    ]
    const metas = metasOf(
      meta({ session_id: 'c1', model: 'claude-sonnet-5', harness: 'claude' }),
      meta({ session_id: 'c2', model: 'gpt-5', harness: 'codex' }),
    )
    const result = subtaskStats({ subtaskId: 's1', rows, metas, createdAt: '2026-09-05T10:00:00.000Z' })
    expect(result).not.toBeNull()
    expect(result!.models.map(b => b.key).sort()).toEqual(['claude-sonnet-5', 'gpt-5'])
    expect(result!.harnesses.map(b => b.key).sort()).toEqual(['claude', 'codex'])
  })
})
