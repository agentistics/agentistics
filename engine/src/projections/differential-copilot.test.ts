import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runCopilotDifferential } from './differential-copilot'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'copilot-differential-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeSession(id: string, lines: string[]): Promise<void> {
  const sessDir = join(dir, id)
  await mkdir(sessDir, { recursive: true })
  const path = join(sessDir, 'events.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  const old = new Date(Date.now() - 120_000)
  await utimes(path, old, old)
}

function line(type: string, data: Record<string, unknown>, ts: string): string {
  return JSON.stringify({ type, data, timestamp: ts })
}

describe('runCopilotDifferential', () => {
  test('a clean session with a canonical-mapped tool name and a shutdown model is EQUAL or explained, never a bug', async () => {
    await writeSession('s1', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T00:00:00.000Z'),
      line('user.message', { content: 'hi' }, '2026-01-01T00:00:01.000Z'),
      line('assistant.turn_start', {}, '2026-01-01T00:00:02.000Z'),
      line('tool.execution_start', { toolCallId: 't1', toolName: 'view', arguments: { path: '/x' } }, '2026-01-01T00:00:03.000Z'),
      line('tool.execution_complete', { toolCallId: 't1', success: true }, '2026-01-01T00:00:04.000Z'),
      line('assistant.message', { content: 'ok' }, '2026-01-01T00:00:05.000Z'),
      line('assistant.turn_end', {}, '2026-01-01T00:00:06.000Z'),
      line('session.shutdown', {
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        modelMetrics: { 'gpt-5-mini': { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
        currentModel: 'gpt-5-mini',
      }, '2026-01-01T00:00:07.000Z'),
    ])

    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true, now: () => Date.now() })
    expect(report.sessions).toBe(1)
    const diff = (report as { diffs?: { rows: { verdict: string; field: string }[] }[] }).diffs![0]!
    const bugs = diff.rows.filter(r => r.verdict === 'bug')
    expect(bugs).toEqual([])
    // tool_counts: the projection keys by canonicalName now, so raw 'view' vs canonical 'Read' is EQUAL.
    const toolCounts = diff.rows.find(r => r.field === 'tool_counts')!
    expect(toolCounts.verdict).toBe('equal') // the projection now keys tool_counts by canonicalName (A3 shared change)
  })

  test('a session with session.error explains tool_errors rather than reporting a bug', async () => {
    await writeSession('s2', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T01:00:00.000Z'),
      line('user.message', { content: 'hi' }, '2026-01-01T01:00:01.000Z'),
      line('session.error', { errorType: 'quota', message: 'no quota', statusCode: 402 }, '2026-01-01T01:00:02.000Z'),
      line('session.shutdown', { codeChanges: {}, modelMetrics: {} }, '2026-01-01T01:00:03.000Z'),
    ])

    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true })
    const diff = (report as { diffs?: { rows: { verdict: string; field: string; reason?: string }[] }[] }).diffs![0]!
    const toolErrors = diff.rows.find(r => r.field === 'tool_errors')!
    expect(toolErrors.verdict).toBe('explained')
  })

  test('the human-turn family is not-projectable, never a bug, even though legacy counts real messages', async () => {
    await writeSession('s3', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T02:00:00.000Z'),
      line('user.message', { content: 'one' }, '2026-01-01T02:00:01.000Z'),
      line('user.message', { content: 'two' }, '2026-01-01T02:00:02.000Z'),
      line('session.shutdown', { codeChanges: {}, modelMetrics: {} }, '2026-01-01T02:00:03.000Z'),
    ])

    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true })
    const diff = (report as { diffs?: { rows: { verdict: string; field: string }[] }[] }).diffs![0]!
    for (const field of ['user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps']) {
      const r = diff.rows.find(x => x.field === field)!
      expect(r.verdict).toBe('not-projectable')
    }
  })

  test('a live session (touched within settledMs) is skipped, never compared', async () => {
    const sessDir = join(dir, 's4')
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, 'events.jsonl'), line('session.start', { context: { cwd: '/tmp' } }, '2026-01-01T00:00:00.000Z') + '\n')
    const report = await runCopilotDifferential({ sessionStateDir: dir, settledMs: 60_000, now: () => Date.now() })
    expect(report.sessions).toBe(0)
    expect(report.skipped.live).toBe(1)
  })

  test('a failed tool.execution_complete is EQUAL: HARNESS_TOOL_RULES.copilot says a failed call is no legacy tool error', async () => {
    await writeSession('s6', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T04:00:00.000Z'),
      line('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: { command: 'false' } }, '2026-01-01T04:00:01.000Z'),
      line('tool.execution_complete', { toolCallId: 't1', success: false }, '2026-01-01T04:00:02.000Z'),
      line('session.shutdown', { codeChanges: {}, modelMetrics: {} }, '2026-01-01T04:00:03.000Z'),
    ])
    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true })
    const diff = (report as { diffs?: { rows: { verdict: string; field: string; legacy?: unknown; projected?: unknown }[] }[] }).diffs![0]!
    const toolErrors = diff.rows.find(r => r.field === 'tool_errors')!
    expect(toolErrors.legacy).toBe(0) // copilot-parse.ts never reads tool.execution_complete's success
    // The replay still emits tool.failed (the fact); the projection counts it as legacy does.
    expect(toolErrors.projected).toBe(0)
    expect(toolErrors.verdict).toBe('equal')
  })

  test('a named-but-never-billed model (currentModel set, modelMetrics empty) explains model/costUSD, not a bug', async () => {
    await writeSession('s7', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T05:00:00.000Z'),
      line('session.shutdown', {
        codeChanges: {}, modelMetrics: {}, currentModel: 'claude-sonnet-4.6', totalApiDurationMs: 0,
      }, '2026-01-01T05:00:01.000Z'),
    ])
    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true })
    const diff = (report as { diffs?: { rows: { verdict: string; field: string; legacy?: unknown; projected?: unknown }[] }[] }).diffs![0]!
    const model = diff.rows.find(r => r.field === 'model')!
    const cost = diff.rows.find(r => r.field === 'costUSD')!
    expect(model.legacy).toBe('claude-sonnet-4.6')
    expect(model.projected).toBeUndefined()
    expect(model.verdict).toBe('explained')
    expect(cost.legacy).toBe(0)
    expect(cost.projected).toBeNull()
    expect(cost.verdict).toBe('explained')
  })

  test('duration_minutes rounding is explained, not a bug', async () => {
    await writeSession('s5', [
      line('session.start', { context: { cwd: '/tmp/proj' } }, '2026-01-01T03:00:00.000Z'),
      // 90 seconds = 1.5 minutes unrounded (legacy), rounds to 2 (projected).
      line('session.shutdown', { codeChanges: {}, modelMetrics: {} }, '2026-01-01T03:01:30.000Z'),
    ])
    const report = await runCopilotDifferential({ sessionStateDir: dir, keepDiffs: true })
    const diff = (report as { diffs?: { rows: { verdict: string; field: string }[] }[] }).diffs![0]!
    const dur = diff.rows.find(r => r.field === 'duration_minutes')!
    expect(dur.verdict).toBe('explained')
  })
})
