import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countGeminiToolErrors,
  recountGeminiModels,
  reclassifyGeminiRows,
  runGeminiDifferential,
  type GeminiDifferentialReport,
} from './differential-gemini'
import type { FieldRow } from './differential'

async function makeGeminiDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentistics-gemini-differential-'))
}

async function writeChat(geminiDir: string, project: string, fileName: string, content: string): Promise<void> {
  const dir = join(geminiDir, 'tmp', project, 'chats')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), content, 'utf-8')
}

const bugRow = (field: string, legacy: unknown, projected: unknown, family: FieldRow['family'] = 'tools'): FieldRow =>
  ({ family, field, verdict: 'bug', legacy, projected })

describe('countGeminiToolErrors', () => {
  test('counts only status === "error" toolCalls, never "cancelled"', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [
        { type: 'gemini', model: 'gemini-3-flash-preview', tokens: { input: 1 }, toolCalls: [
          { id: 'a', name: 'read_file', status: 'success' },
          { id: 'b', name: 'replace', status: 'error' },
          { id: 'c', name: 'replace', status: 'cancelled' },
        ] },
      ],
    })
    expect(countGeminiToolErrors(content)).toBe(1)
  })

  test('a jsonl-shape (or any non-rich-json) file counts zero — it never carries toolCalls', () => {
    const jsonl = [
      JSON.stringify({ sessionId: 's', startTime: 't', lastUpdated: 't', kind: 'main' }),
      JSON.stringify({ $set: { messages: [] } }),
    ].join('\n')
    expect(countGeminiToolErrors(jsonl)).toBe(0)
    expect(countGeminiToolErrors('')).toBe(0)
    expect(countGeminiToolErrors('not json')).toBe(0)
  })
})

describe('recountGeminiModels', () => {
  test('first and last model across gemini messages, in array order', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [
        { type: 'gemini', model: 'model-a', tokens: {} },
        { type: 'user', content: [{ text: 'x' }] },
        { type: 'gemini', model: 'model-b', tokens: {} },
      ],
    })
    expect(recountGeminiModels(content)).toEqual({ first: 'model-a', last: 'model-b' })
  })

  test('a single model reports it as both first and last', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [{ type: 'gemini', model: 'only-model', tokens: {} }],
    })
    expect(recountGeminiModels(content)).toEqual({ first: 'only-model', last: 'only-model' })
  })
})

describe('reclassifyGeminiRows', () => {
  test('a turn-family bug is reclassified not-projectable, unconditionally', () => {
    const rows = [bugRow('user_message_count', 5, undefined, 'time')]
    const out = reclassifyGeminiRows(rows, '{}')
    expect(out[0]!.verdict).toBe('not-projectable')
    expect(out[0]!.reason).toContain('turn.started')
  })

  test('a turn-family row reads not-projectable even if it happened to be equal — the field is not-projectable as a fact about the vocabulary, not a per-session coincidence', () => {
    const rows: FieldRow[] = [{ family: 'time', field: 'rounds', verdict: 'equal', legacy: 0, projected: 0 }]
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('not-projectable')
  })

  test('tool_errors: legacy 0 vs projected N is explained when the recount agrees', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [{ type: 'gemini', model: 'm', tokens: {}, toolCalls: [{ id: 'a', name: 'replace', status: 'error' }] }],
    })
    const rows = [bugRow('tool_errors', 0, 1)]
    const out = reclassifyGeminiRows(rows, content)
    expect(out[0]!.verdict).toBe('explained')
    expect(out[0]!.reason).toContain('gemini-parse.ts never reads')
  })

  test('tool_errors: a genuine mismatch (recount disagrees) stays a bug', () => {
    const rows = [bugRow('tool_errors', 0, 5)] // recount of '{}' is 0, not 5
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('bug')
  })

  test('tool_error_categories: legacy {} vs a non-empty projected object is explained', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [{ type: 'gemini', model: 'm', tokens: {}, toolCalls: [{ id: 'a', name: 'replace', status: 'error' }] }],
    })
    const rows = [bugRow('tool_error_categories', {}, { replace: 1 })]
    expect(reclassifyGeminiRows(rows, content)[0]!.verdict).toBe('explained')
  })

  test('model: legacy=last, projected=first, and they differ — explained', () => {
    const content = JSON.stringify({
      startTime: 't', lastUpdated: 't',
      messages: [
        { type: 'gemini', model: 'model-a', tokens: {} },
        { type: 'gemini', model: 'model-b', tokens: {} },
      ],
    })
    const rows = [bugRow('model', 'model-b', 'model-a', 'tokens')]
    const out = reclassifyGeminiRows(rows, content)
    expect(out[0]!.verdict).toBe('explained')
    expect(out[0]!.reason).toContain('parseRichJson')
  })

  test('model: a mismatch the recount does NOT reproduce stays a bug', () => {
    const content = JSON.stringify({ startTime: 't', lastUpdated: 't', messages: [{ type: 'gemini', model: 'only', tokens: {} }] })
    const rows = [bugRow('model', 'something-else', 'only', 'tokens')]
    expect(reclassifyGeminiRows(rows, content)[0]!.verdict).toBe('bug')
  })

  test('duration_minutes: round(legacy) === projected is explained', () => {
    const rows = [bugRow('duration_minutes', 4.7, 5, 'time')]
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('explained')
  })

  test('duration_minutes: a real mismatch stays a bug', () => {
    const rows = [bugRow('duration_minutes', 4.7, 9, 'time')]
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('bug')
  })

  test('daily.<day>.tokens: legacy undefined (no daily field at all) vs a real projected bucket is explained', () => {
    const rows = [bugRow('daily.2026-03-01.tokens', undefined, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 'time')]
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('explained')
  })

  test('a field this module has no rule for stays a bug untouched', () => {
    const rows = [bugRow('lines_added', 0, 3)]
    expect(reclassifyGeminiRows(rows, '{}')[0]!.verdict).toBe('bug')
  })
})

describe('runGeminiDifferential — end to end over a throwaway store', () => {
  test('a plain rich-json session with a tool error and a model switch reports EQUAL/EXPLAINED, never a bug', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      const content = JSON.stringify({
        sessionId: 'x', startTime: '2026-03-01T10:00:00.000Z', lastUpdated: '2026-03-01T10:04:30.000Z',
        messages: [
          { id: 'u1', timestamp: '2026-03-01T10:00:00.000Z', type: 'user', content: [{ text: 'hi' }] },
          {
            id: 'g1', timestamp: '2026-03-01T10:00:10.000Z', type: 'gemini', content: 'ok',
            model: 'gemini-3-flash-preview', tokens: { input: 100, output: 10, cached: 0 },
            toolCalls: [{ id: 'tc1', name: 'replace', args: { file_path: 'x' }, status: 'error', timestamp: '2026-03-01T10:00:12.000Z' }],
          },
          {
            id: 'g2', timestamp: '2026-03-01T10:04:00.000Z', type: 'gemini', content: 'done',
            model: 'gemini-4-preview', tokens: { input: 50, output: 5, cached: 0 },
          },
        ],
      })
      await writeChat(geminiDir, 'proj', 'session-e2e.json', content)

      const report: GeminiDifferentialReport = await runGeminiDifferential({ geminiDir, settledMs: 0, keepDiffs: true })

      expect(report.sessions).toBe(1)
      expect(report.sessionsWithBugs).toBe(0)
      expect(report.shapes.richJson).toBe(1)
      expect(report.shapes.jsonl).toBe(0)

      const diff = (report as GeminiDifferentialReport & { diffs?: { rows: FieldRow[] }[] }).diffs![0]!
      for (const r of diff.rows) expect(r.verdict).not.toBe('bug')
      const modelRow = diff.rows.find(r => r.field === 'model')!
      expect(modelRow.verdict).toBe('explained')
      const toolErrRow = diff.rows.find(r => r.field === 'tool_errors')!
      expect(toolErrRow.verdict).toBe('explained')
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('a jsonl-shape session (no tokens/tools at all) is EQUAL on every projectable field', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      const jsonl = [
        JSON.stringify({ sessionId: 's', startTime: '2026-04-01T08:00:00.000Z', lastUpdated: '2026-04-01T08:00:00.000Z', kind: 'main' }),
        JSON.stringify({ $set: { messages: [] } }),
        JSON.stringify({ id: 'j1', timestamp: '2026-04-01T08:00:05.000Z', type: 'user', content: [{ text: 'hi' }] }),
        JSON.stringify({ id: 'j2', timestamp: '2026-04-01T08:00:20.000Z', type: 'gemini', content: 'hello', tokens: { input: 1, output: 1 }, model: 'x' }),
      ].join('\n')
      await writeChat(geminiDir, 'proj', 'session-jsonl.jsonl', jsonl)

      const report = await runGeminiDifferential({ geminiDir, settledMs: 0, keepDiffs: true })
      expect(report.sessions).toBe(1)
      expect(report.shapes.jsonl).toBe(1)
      expect(report.sessionsWithBugs).toBe(0)
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('a bootstrap-only file (no genuine content) is skipped entirely, not counted or reported', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      const content = JSON.stringify({
        startTime: '2026-03-02T09:00:00.000Z', lastUpdated: '2026-03-02T09:00:01.000Z',
        messages: [{ id: 'u1', timestamp: '2026-03-02T09:00:00.500Z', type: 'user', content: [{ text: '<session_context>\nx\n</session_context>' }] }],
      })
      await writeChat(geminiDir, 'proj', 'session-bootstrap.json', content)

      const report = await runGeminiDifferential({ geminiDir, settledMs: 0 })
      expect(report.sessions).toBe(0)
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('a live (recently-written) file is skipped and counted', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'proj', 'session-live.json', JSON.stringify({
        startTime: 't', lastUpdated: 't', messages: [{ type: 'gemini', content: 'x', tokens: {} }],
      }))
      const report = await runGeminiDifferential({ geminiDir, settledMs: 10 * 60_000 })
      expect(report.skipped.live).toBe(1)
      expect(report.sessions).toBe(0)
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })
})
