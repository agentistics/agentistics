import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionJsonl } from './jsonl'

/**
 * DEFECT M-3 — a transcript nothing was ever walked over got MEASURED zeros.
 *
 * `finishClaudeSession` wrote `duration_minutes: 0` and `compact_count: 0` / `compact_ms: 0` /
 * `skill_uses: {}` whenever `source === 'jsonl'`, with no check that the walk had actually folded
 * a single entry. Proven on real session f455dc9a (a 0-byte transcript). The canonical
 * replay/projection (`origin/fix/parity-residuals`'s `projections/session-meta.ts`) reports
 * `duration_minutes` absent unless a `session.started`/`session.ended` pair was seen, and
 * `compact_count` absent unless at least one agent recorded events — i.e. absent whenever nothing
 * was read, never a confident 0. Legacy must agree.
 */
describe('finishClaudeSession on a transcript nothing was walked over', () => {
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'agentistics-jsonl-empty-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a 0-byte transcript reports duration/compaction as ABSENT, never a measured 0', async () => {
    const file = join(dir, 'zero-bytes.jsonl')
    writeFileSync(file, '')
    const s = await parseSessionJsonl(file, 'zero-bytes', '/p', 'jsonl')

    expect(s.duration_minutes).toBeUndefined()
    expect(s.compact_count).toBeUndefined()
    expect(s.compact_ms).toBeUndefined()
    expect(s.compact_dropped_tokens).toBeUndefined()
    expect(s.skill_uses).toBeUndefined()
    // active_minutes was already correct (finishActiveTime already answers undefined on no timing) —
    // pinned here so a future change can't quietly regress it alongside the fields above.
    expect(s.active_minutes).toBeUndefined()
  })

  it('a transcript of only blank lines is the same "nothing was walked" case', async () => {
    // Nonzero bytes, but no line ever parses into an entry — same class of bug as the 0-byte file:
    // a walk that saw no ENTRY, not merely a file with no bytes.
    const file = join(dir, 'blank-lines.jsonl')
    writeFileSync(file, '\n\n\n')
    const s = await parseSessionJsonl(file, 'blank-lines', '/p', 'jsonl')

    expect(s.duration_minutes).toBeUndefined()
    expect(s.compact_count).toBeUndefined()
    expect(s.skill_uses).toBeUndefined()
  })

  it('a transcript of only unparseable JSON is also "nothing was walked"', async () => {
    const file = join(dir, 'garbage.jsonl')
    writeFileSync(file, '{ not json\nalso not json\n')
    const s = await parseSessionJsonl(file, 'garbage', '/p', 'jsonl')

    expect(s.duration_minutes).toBeUndefined()
    expect(s.compact_count).toBeUndefined()
    expect(s.skill_uses).toBeUndefined()
  })

  it('a GENUINELY quiet but real transcript still reports real zeros, not absence', async () => {
    // The guard: this defect's fix must not turn a real "0 compactions" into an absence too. One
    // user turn, one assistant turn, no compaction, no skill, but a real walk with real timestamps.
    const file = join(dir, 'quiet.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:00Z', cwd: '/p', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T10:00:05Z', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join('\n'))
    const s = await parseSessionJsonl(file, 'quiet', '/p', 'jsonl')

    expect(s.duration_minutes).toBe(0) // real: both turns 5s apart, rounds to 0 minutes
    expect(s.compact_count).toBe(0)
    expect(s.compact_ms).toBe(0)
    expect(s.skill_uses).toEqual({})
    expect(s.compact_dropped_tokens).toBeUndefined()
  })

  it('a file that cannot even be opened (makeEmptySession) reports duration as ABSENT too', async () => {
    const s = await parseSessionJsonl(join(dir, 'does-not-exist.jsonl'), 'missing', '/p', 'jsonl')
    expect(s.duration_minutes).toBeUndefined()
  })
})
