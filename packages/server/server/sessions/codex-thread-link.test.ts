import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkCodexProcesses, START_SKEW_MS, type CodexThread } from './codex-thread-link'
import { codexStatePath, readCodexProcessSessions } from './codex-thread-log'

const T0 = 1_793_887_517_803
const th = (id: string, cwd: string, createdMs: number, archived = false): CodexThread => ({ id, cwd, createdMs, archived })

describe('linkCodexProcesses', () => {
  test('pairs a process with the thread created in its cwd at its start', () => {
    const m = linkCodexProcesses([{ pid: 1, cwd: '/a', startedMs: T0 + 3000 }], [th('x', '/a', T0), th('y', '/b', T0)])
    expect(m.get(1)).toBe('x')
  })
  test('refuses: wrong cwd, outside the window, archived, taken, no start time', () => {
    const p = { pid: 1, cwd: '/a', startedMs: T0 }
    expect(linkCodexProcesses([p], [th('x', '/b', T0)]).size).toBe(0)
    expect(linkCodexProcesses([p], [th('x', '/a', T0 + START_SKEW_MS + 1)]).size).toBe(0)
    expect(linkCodexProcesses([p], [th('x', '/a', T0, true)]).size).toBe(0)
    expect(linkCodexProcesses([p], [th('x', '/a', T0)], undefined, new Set(['x'])).size).toBe(0)
    expect(linkCodexProcesses([{ pid: 1, cwd: '/a' }], [th('x', '/a', T0)]).size).toBe(0)
  })
  test('refuses ambiguity both ways', () => {
    expect(linkCodexProcesses([{ pid: 1, cwd: '/a', startedMs: T0 }], [th('x', '/a', T0), th('y', '/a', T0 + 1)]).size).toBe(0)
    expect(linkCodexProcesses([{ pid: 1, cwd: '/a', startedMs: T0 }, { pid: 2, cwd: '/a', startedMs: T0 + 5 }], [th('x', '/a', T0)]).size).toBe(0)
  })
})

describe('readCodexProcessSessions (fixture state_5.sqlite)', () => {
  test('reads the newest state file read-only and links by cwd + start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-state-'))
    try {
      const db = new Database(join(dir, 'state_5.sqlite'))
      db.run('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0)')
      db.run('INSERT INTO threads VALUES (?,?,?,0)', ['01a1ac07-374e-7d80-9c52-8ff440d1c09f', '/w/proj', T0])
      db.close()
      expect(codexStatePath(dir)).toBe(join(dir, 'state_5.sqlite'))
      const m = await readCodexProcessSessions([{ pid: 7, cwd: '/w/proj', startedMs: T0 + 2000 }], codexStatePath(dir))
      expect(m.get(7)).toBe('01a1ac07-374e-7d80-9c52-8ff440d1c09f')
      expect((await readCodexProcessSessions([{ pid: 7, cwd: '/w/proj', startedMs: T0 }], join(dir, 'nope.sqlite'))).size).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
