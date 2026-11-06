import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropWrapperParents, linkCodexProcesses, START_SKEW_MS, type CodexThread } from './codex-thread-link'
import { codexStatePath, codexStatePathOfFds, readCodexProcessSessions, readCodexThreads } from './codex-thread-log'

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
      db.run('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT \'cli\', agent_role TEXT)')
      db.run('INSERT INTO threads (id, cwd, created_at_ms) VALUES (?,?,?)', ['01a1ac07-374e-7d80-9c52-8ff440d1c09f', '/w/proj', T0])
      db.close()
      expect(codexStatePath(dir)).toBe(join(dir, 'state_5.sqlite'))
      const m = await readCodexProcessSessions([{ pid: 7, cwd: '/w/proj', startedMs: T0 + 2000 }], codexStatePath(dir))
      expect(m.get(7)).toBe('01a1ac07-374e-7d80-9c52-8ff440d1c09f')
      expect((await readCodexProcessSessions([{ pid: 7, cwd: '/w/proj', startedMs: T0 }], join(dir, 'nope.sqlite'))).size).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('dropWrapperParents (npm/bun codex.js spawns the native binary and stays alive)', () => {
  test('drops the codex process whose child is also codex; keeps unrelated ones', () => {
    const procs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 20, ppid: 1 }]
    expect(dropWrapperParents(procs).map(p => p.pid)).toEqual([11, 20])
  })
  test('wrapper + child no longer makes a thread ambiguous', () => {
    const procs = dropWrapperParents([
      { pid: 10, ppid: 1, cwd: '/a', startedMs: T0 }, { pid: 11, ppid: 10, cwd: '/a', startedMs: T0 + 40 },
    ])
    expect(linkCodexProcesses(procs, [th('x', '/a', T0)]).get(11)).toBe('x')
  })
})

describe('ambiguity against processes that already have an id', () => {
  test('a process with a known id is not a candidate for its thread, and makes no claim of its own', () => {
    const m = linkCodexProcesses([{ pid: 2, cwd: '/a', startedMs: T0 + 5 }], [th('x', '/a', T0), th('y', '/a', T0 + 2)], undefined, new Set(['x']))
    expect(m.get(2)).toBe('y')
  })
})

describe('state path from the process fds', () => {
  test('picks the highest state_N.sqlite among open fds', () => {
    expect(codexStatePathOfFds(['/dev/pts/1', '/h/a/state_4.sqlite', '/h/a/state_5.sqlite', '/h/a/logs_2.sqlite'])).toBe('/h/a/state_5.sqlite')
    expect(codexStatePathOfFds(['/dev/null', '/h/state_5.sqlite-wal'])).toBeNull()
  })
})

describe('thread filter and per-process windows', () => {
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-state-'))
    const db = new Database(join(dir, 'state_5.sqlite'))
    db.run('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT \'cli\', agent_role TEXT)')
    return { dir, db, path: join(dir, 'state_5.sqlite') }
  }
  test('codex exec and subagent threads are not candidates', async () => {
    const { dir, db, path } = mk()
    try {
      db.run("INSERT INTO threads VALUES ('real','/w',?,0,'cli',NULL)", [T0])
      db.run("INSERT INTO threads VALUES ('ex','/w',?,0,'exec',NULL)", [T0 + 1000])
      db.run("INSERT INTO threads VALUES ('sub','/w',?,0,'cli','worker')", [T0 + 2000])
      db.close()
      const m = await readCodexProcessSessions([{ pid: 1, cwd: '/w', startedMs: T0 + 500 }], path)
      expect(m.get(1)).toBe('real')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('no blind LIMIT: 600 newer threads elsewhere do not hide a rival candidate', async () => {
    const { dir, db, path } = mk()
    try {
      db.run("INSERT INTO threads VALUES ('a','/w',?,0,'cli',NULL)", [T0])
      db.run("INSERT INTO threads VALUES ('b','/w',?,0,'cli',NULL)", [T0 + 100])
      db.transaction(() => { for (let i = 0; i < 600; i++) db.run("INSERT INTO threads VALUES (?,'/other',?,0,'cli',NULL)", ['o' + i, T0 + 200 + i]) })()
      db.close()
      expect((await readCodexProcessSessions([{ pid: 1, cwd: '/w', startedMs: T0 + 50 }], path)).size).toBe(0)
      expect(readCodexThreads(path, T0, T0 + 10_000).length).toBeGreaterThan(500)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
