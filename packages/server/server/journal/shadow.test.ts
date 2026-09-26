/**
 * shadow.test.ts — the shadow writer against a REAL journal (bun:sqlite on a temp dir) and the REAL
 * Claude replay over a disposable projects tree. Only the failure cases inject: a journal that
 * throws on open, a replay that throws, a journal that drops. No provider is ever called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile, appendFile, utimes, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { createClaudeReplay } from '../integrations/claude'
import type { HarnessReplay } from '../integrations/types'
import type { JournalStatus } from './types'
import { openJournal } from './journal'
import { canSkip, claudeStamps, createShadow, SETTLE_MARGIN_MS, type ShadowStatusFile } from './shadow'

let root = ''
let seq = 0
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-shadow-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const user = (ts: string, cwd?: string) =>
  JSON.stringify({ type: 'user', timestamp: ts, ...(cwd ? { cwd } : {}), version: '2.1.0' }) + '\n'
const assistant = (id: string, ts: string) => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [] },
}) + '\n'

/** A private world: a projects dir with N conversations, and where the journal + status live. */
async function world(conversations: string[]) {
  const base = join(root, `w${++seq}`)
  const projectsDir = join(base, 'projects')
  await mkdir(join(projectsDir, 'p'), { recursive: true })
  for (const id of conversations) {
    await writeFile(
      join(projectsDir, 'p', `${id}.jsonl`),
      user('2026-01-01T00:00:00.000Z', '/x') + assistant(`msg-${id}-1`, '2026-01-01T00:00:01.000Z')
        + assistant(`msg-${id}-2`, '2026-01-01T00:00:02.000Z'),
    )
  }
  return {
    projectsDir,
    journalPath: join(base, 'journal.db'),
    statusPath: join(base, 'journal.db.status.json'),
    replay: createClaudeReplay({ projectsDir, settledMs: 0 }),
  }
}

const sessions = (...ids: string[]) => ids.map(session_id => ({ session_id }))

describe('flag off', () => {
  test('is not a code path: nothing opened, nothing created, nothing scanned', async () => {
    const w = await world(['a'])
    let opened = 0
    let discovered = 0
    const shadow = createShadow({
      enabled: false,
      open: async () => { opened++; throw new Error('must not open') },
      replay: { discover: async () => { discovered++; return [] }, replay: async () => { throw new Error('no') } },
      statusPath: w.statusPath,
    })
    expect(await shadow.ingest(sessions('a'))).toEqual({ status: 'off' })
    expect(opened).toBe(0)
    expect(discovered).toBe(0)
    expect(existsSync(w.statusPath)).toBe(false)
    expect(existsSync(w.journalPath)).toBe(false)
  })
})

describe('flag on', () => {
  test('writes every Claude session it read, and ingesting the same build twice changes nothing', async () => {
    const w = await world(['a', 'b'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: w.statusPath, registerStatus: () => {} })

    const first = await shadow.ingest(sessions('a', 'b'))
    expect(first.status).toBe('ran')
    if (first.status !== 'ran') return
    expect(first.sources).toBe(2)
    expect(first.written).toBeGreaterThan(0)
    expect(first.rejected).toBe(0)
    const rows = (await journal.stats()).rows
    expect(rows).toBe(first.written)

    // A brand-new shadow (a restart: the cursor is gone) re-reads everything; the journal says so.
    const second = createShadow({ enabled: true, open: async () => journal, replay: createClaudeReplay({ projectsDir: w.projectsDir, settledMs: 0 }), statusPath: null, registerStatus: () => {} })
    const again = await second.ingest(sessions('a', 'b'))
    expect(again.status).toBe('ran')
    if (again.status === 'ran') {
      expect(again.written).toBe(0)
      expect(again.duplicates).toBeGreaterThan(0)
    }
    expect((await journal.stats()).rows).toBe(rows)
    journal.close()
  })

  test('only sessions the build listed are replayed, and non-claude harnesses are skipped', async () => {
    const w = await world(['a', 'b'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: null, registerStatus: () => {} })
    const r = await shadow.ingest([{ session_id: 'a' }, { session_id: 'b', harness: 'codex' }])
    expect(r.status === 'ran' && r.sources).toBe(1)
    journal.close()
  })

  test('a grown transcript adds only its new events on the next ingest', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: null, registerStatus: () => {} })
    await shadow.ingest(sessions('a'))
    const before = (await journal.stats()).rows
    await appendFile(join(w.projectsDir, 'p', 'a.jsonl'), assistant('msg-a-3', '2026-01-01T00:00:03.000Z'))
    const r = await shadow.ingest(sessions('a'))
    expect(r.status === 'ran' && r.written).toBeGreaterThan(0)
    expect((await journal.stats()).rows).toBeGreaterThan(before)
    journal.close()
  })

  test('events are flushed in bounded slices, never handed over as one array', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const sizes: number[] = []
    const spy = { ...journal, append: (e: readonly AgentisticsEvent[]) => { sizes.push(e.length); return journal.append(e) } }
    const shadow = createShadow({ enabled: true, open: async () => spy, replay: w.replay, statusPath: null, flushEvents: 2, registerStatus: () => {} })
    const r = await shadow.ingest(sessions('a'))
    expect(r.status === 'ran' && r.events).toBeGreaterThan(2)
    expect(sizes.length).toBeGreaterThan(1)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2)
    journal.close()
  })

  test('registers the journal status with health, and close() unregisters it', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const registered: (null | (() => JournalStatus | null))[] = []
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: null, registerStatus: s => { registered.push(s) } })
    await shadow.ingest(sessions('a'))
    expect(registered).toHaveLength(1)
    expect(registered[0]!()?.state).toBe('open')
    shadow.close()
    expect(registered[registered.length - 1]).toBeNull()
  })

  test('writes the since-boot counters to the status file another process reads', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: w.statusPath, registerStatus: () => {} })
    await shadow.ingest(sessions('a'))
    const file = JSON.parse(readFileSync(w.statusPath, 'utf8')) as ShadowStatusFile
    expect(file.v).toBe(1)
    expect(file.pid).toBe(process.pid)
    expect(file.runs).toBe(1)
    expect(file.sinceBoot.counters.written).toBeGreaterThan(0)
    expect(file.sinceBoot.counters.dropped).toBe(0)
    journal.close()
  })
})

describe('failure isolation — a shadow can only log', () => {
  test('a journal that cannot be opened is a failed result and a warning, never a throw; the next run retries', async () => {
    const w = await world(['a'])
    const warnings: string[] = []
    let attempts = 0
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({
      enabled: true, replay: w.replay, statusPath: null, registerStatus: () => {}, warn: m => warnings.push(m),
      open: async () => { if (++attempts === 1) throw new Error('disk on fire'); return journal },
    })
    expect(await shadow.ingest(sessions('a'))).toEqual({ status: 'failed' })
    expect(warnings.join()).toContain('disk on fire')
    expect((await shadow.ingest(sessions('a'))).status).toBe('ran')
    journal.close()
  })

  test('a replay that throws costs that conversation only', async () => {
    const w = await world(['a', 'b'])
    const journal = await openJournal({ path: w.journalPath })
    const bad: HarnessReplay = {
      discover: () => w.replay.discover(),
      replay: (src, cur) => { if (src.sessionId === 'a') throw new Error('boom'); return w.replay.replay(src, cur) },
    }
    const warnings: string[] = []
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: bad, statusPath: null, registerStatus: () => {}, warn: m => warnings.push(m) })
    const r = await shadow.ingest(sessions('a', 'b'))
    expect(r.status === 'ran' && r.written).toBeGreaterThan(0)
    expect(warnings.some(m => m.includes('claude:a'))).toBe(true)
    journal.close()
  })

  test('a disabled journal (network filesystem) drops and counts; the cursor does not advance', async () => {
    const w = await world(['a'])
    const journal = await openJournal({
      path: w.journalPath,
      probe: { platform: 'linux', realpath: p => p, readMountinfo: () => '58 42 0:50 / / rw - nfs4 srv:/x rw', readDarwinMounts: () => null },
    })
    expect(journal.status().state).toBe('disabled')
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: null, registerStatus: () => {} })
    const r = await shadow.ingest(sessions('a'))
    expect(r.status === 'ran' && r.written).toBe(0)
    expect(r.status === 'ran' && r.dropped).toBeGreaterThan(0)
    // Nothing was accepted, so a healthy journal later must still get the whole conversation.
    expect(shadow.sinceBoot().counters.dropped).toBeGreaterThan(0)
  })

  test('a status file that cannot be written is a warning, not a failure', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const warnings: string[] = []
    const shadow = createShadow({
      enabled: true, open: async () => journal, replay: w.replay, registerStatus: () => {}, warn: m => warnings.push(m),
      statusPath: join(w.journalPath, 'not-a-dir', 'x.json'), // journal.db is a FILE; a child of it cannot exist
    })
    expect((await shadow.ingest(sessions('a'))).status).toBe('ran')
    expect(warnings.join()).toContain('shadow status file')
    journal.close()
  })

  test('overlapping ingests are single-flight: the second is skipped as busy and counted', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: w.statusPath, registerStatus: () => {} })
    const [x, y] = await Promise.all([shadow.ingest(sessions('a')), shadow.ingest(sessions('a'))])
    expect([x.status, y.status].sort()).toEqual(['busy', 'ran'])
    await shadow.ingest(sessions('a'))
    expect((JSON.parse(readFileSync(w.statusPath, 'utf8')) as ShadowStatusFile).skippedBusy).toBe(1)
    journal.close()
  })
})

describe('what reaches the journal', () => {
  test('every event carries adapterVersion, confidence and a sourceRef; no raw text field', async () => {
    const w = await world(['a'])
    const journal = await openJournal({ path: w.journalPath })
    const shadow = createShadow({ enabled: true, open: async () => journal, replay: w.replay, statusPath: null, registerStatus: () => {} })
    await shadow.ingest(sessions('a'))
    const page = await journal.readFrom(0, 1000)
    expect(page.events.length).toBeGreaterThan(0)
    for (const e of page.events) {
      expect(e.provenance.adapterVersion.length).toBeGreaterThan(0)
      expect(['exact', 'estimated', 'inferred']).toContain(e.provenance.confidence)
      expect((e.provenance.sourceRef ?? '').length).toBeGreaterThan(0)
    }
    journal.close()
  })
})

describe('an unchanged transcript is not replayed (the measured cost of not doing so: 407 k events per run)', () => {
  const settle = async (w: Awaited<ReturnType<typeof world>>, id: string) => {
    const old = new Date(Date.now() - 3600_000)
    await utimes(join(w.projectsDir, 'p', `${id}.jsonl`), old, old)
  }
  /** A replay that counts what it is asked, over the real one. */
  const counting = (w: Awaited<ReturnType<typeof world>>) => {
    const asked: string[] = []
    const replay: HarnessReplay = {
      discover: () => w.replay.discover(),
      replay: (src, cur) => { asked.push(src.sessionId); return w.replay.replay(src, cur) },
    }
    return { asked, replay }
  }

  test('canSkip: same stamp AND settled at the last replay; anything else replays', () => {
    const stamp = { key: '10:1000', mtimeMs: 1000 }
    const settled = { ...stamp, replayedAtMs: 1000 + SETTLE_MARGIN_MS }
    expect(canSkip(settled, stamp)).toBe(true)
    expect(canSkip({ ...settled, replayedAtMs: 1000 + SETTLE_MARGIN_MS - 1 }, stamp)).toBe(false) // was still live then
    expect(canSkip(settled, { ...stamp, key: '11:1001' })).toBe(false) // it changed
    expect(canSkip(undefined, stamp)).toBe(false)
    expect(canSkip(settled, undefined)).toBe(false)
  })

  test('claudeStamps: one per transcript, and a subagent file changes its parent\'s stamp', async () => {
    const w = await world(['a', 'b'])
    const before = await claudeStamps(w.projectsDir)
    expect([...before.keys()].sort()).toEqual(['a', 'b'])
    await mkdir(join(w.projectsDir, 'p', 'a', 'subagents'), { recursive: true })
    await writeFile(join(w.projectsDir, 'p', 'a', 'subagents', 'agent-1.jsonl'), '{}\n')
    const after = await claudeStamps(w.projectsDir)
    expect(after.get('a')!.key).not.toBe(before.get('a')!.key)
    expect(after.get('b')!.key).toBe(before.get('b')!.key)
    expect(await claudeStamps(join(w.projectsDir, 'nope'))).toEqual(new Map())
  })

  test('a settled, unchanged store is skipped whole — including after a restart', async () => {
    const w = await world(['a', 'b'])
    await settle(w, 'a'); await settle(w, 'b')
    const journal = await openJournal({ path: w.journalPath })
    const first = counting(w)
    const s1 = createShadow({ enabled: true, open: async () => journal, replay: first.replay, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    const r1 = await s1.ingest(sessions('a', 'b'))
    expect(r1.status === 'ran' && r1.sources).toBe(2)
    expect(first.asked.sort()).toEqual(['a', 'b'])

    // A NEW shadow object = a restarted server: memory is gone, the stamps file beside the journal is not.
    const second = counting(w)
    const s2 = createShadow({ enabled: true, open: async () => journal, replay: second.replay, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    const r2 = await s2.ingest(sessions('a', 'b'))
    expect(r2.status === 'ran' && [r2.sources, r2.skipped, r2.events]).toEqual([0, 2, 0])
    expect(second.asked).toEqual([])
    journal.close()
  })

  test('only the transcript that grew is replayed', async () => {
    const w = await world(['a', 'b'])
    await settle(w, 'a'); await settle(w, 'b')
    const journal = await openJournal({ path: w.journalPath })
    const mk = (r: HarnessReplay) => createShadow({ enabled: true, open: async () => journal, replay: r, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    await mk(counting(w).replay).ingest(sessions('a', 'b'))
    await appendFile(join(w.projectsDir, 'p', 'b.jsonl'), assistant('msg-b-3', '2026-01-01T00:00:03.000Z'))
    await settle(w, 'b') // grown, and quiet again
    const c = counting(w)
    const r = await mk(c.replay).ingest(sessions('a', 'b'))
    expect(c.asked).toEqual(['b'])
    expect(r.status === 'ran' && r.written).toBeGreaterThan(0)
    journal.close()
  })

  test('a source replayed while still LIVE is replayed once more after it settles', async () => {
    const w = await world(['a']) // mtime = now: live
    const journal = await openJournal({ path: w.journalPath })
    const mk = (r: HarnessReplay, now?: () => number) => createShadow({ enabled: true, open: async () => journal, replay: r, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {}, ...(now ? { now } : {}) })
    await mk(counting(w).replay).ingest(sessions('a'))
    const again = counting(w)
    await mk(again.replay).ingest(sessions('a'))
    expect(again.asked).toEqual(['a']) // unchanged, but it was live when last read
    await settle(w, 'a') // it goes quiet (the stamp's mtime moves, so this is the "changed" branch too)
    const c = counting(w)
    await mk(c.replay).ingest(sessions('a'))
    expect(c.asked).toEqual(['a'])
    const settledRun = counting(w)
    await mk(settledRun.replay).ingest(sessions('a'))
    expect(settledRun.asked).toEqual([]) // now it is settled AND accepted: done
    journal.close()
  })

  test('a replaced journal inherits no stamps', async () => {
    const w = await world(['a'])
    await settle(w, 'a')
    let journal = await openJournal({ path: w.journalPath })
    const mk = (r: HarnessReplay) => createShadow({ enabled: true, open: async () => journal, replay: r, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    await mk(counting(w).replay).ingest(sessions('a'))
    journal.close()
    for (const f of [w.journalPath, `${w.journalPath}-wal`, `${w.journalPath}-shm`]) await unlink(f).catch(() => {})
    journal = await openJournal({ path: w.journalPath }) // a different file now
    const c = counting(w)
    await mk(c.replay).ingest(sessions('a'))
    expect(c.asked).toEqual(['a'])
    journal.close()
  })
})

// ---- the real entry points, in a child process (the flag is read once, at import) ----------------

const SERVER_DIR = join(import.meta.dir, '..')

async function child(script: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, '-e', script], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? '', HOME: env.CLAUDE_DIR ? join(env.CLAUDE_DIR, '..', 'home') : (process.env.HOME ?? ''), ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: out.trim(), err }
}

describe('the real flag and the real data.ts call', () => {
  test('flag absent: shadowIngest answers off and no journal file is created', async () => {
    const dir = join(root, `iso-${++seq}`)
    const r = await child(
      `import { shadowIngest } from './journal/shadow'; console.log(JSON.stringify(await shadowIngest([{ session_id: 'x' }])))`,
      { AGENTISTICS_DIR: dir, CLAUDE_DIR: join(dir, 'claude') },
    )
    expect(r.out).toBe('{"status":"off"}')
    // (other modules may create the data dir on import; the journal and its status file must not exist)
    expect(existsSync(join(dir, 'journal.db'))).toBe(false)
    expect(existsSync(join(dir, 'journal.db.status.json'))).toBe(false)
  })

  test('flag on, journal UNOPENABLE: a full buildApiResponse still returns its sessions', async () => {
    const dir = join(root, `iso-${++seq}`)
    await mkdir(dir, { recursive: true })
    const notADir = join(dir, 'file')
    await writeFile(notADir, 'x')
    const claude = join(dir, 'claude')
    await mkdir(join(claude, 'projects', 'p'), { recursive: true })
    await writeFile(
      join(claude, 'projects', 'p', 'c1.jsonl'),
      user('2026-01-01T00:00:00.000Z', '/x') + assistant('m1', '2026-01-01T00:00:01.000Z'),
    )
    const r = await child(
      `import { buildApiResponse } from './data'; const a = await buildApiResponse(); await Bun.sleep(300); console.log(JSON.stringify({ n: a.sessions.length })); process.exit(0)`,
      { AGENTISTICS_JOURNAL: '1', AGENTISTICS_DIR: join(dir, 'data'), AGENTISTICS_JOURNAL_DIR: join(notADir, 'sub'), CLAUDE_DIR: claude },
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.split('\n').pop()!)).toEqual({ n: 1 })
  }, 60_000)

  test('flag on, journal healthy: the build feeds it and the status file names this run', async () => {
    const dir = join(root, `iso-${++seq}`)
    const claude = join(dir, 'claude')
    await mkdir(join(claude, 'projects', 'p'), { recursive: true })
    await writeFile(
      join(claude, 'projects', 'p', 'c1.jsonl'),
      user('2026-01-01T00:00:00.000Z', '/x') + assistant('m1', '2026-01-01T00:00:01.000Z'),
    )
    const data = join(dir, 'data')
    const r = await child(
      `import { buildApiResponse } from './data'; await buildApiResponse(); await Bun.sleep(1500); console.log('done'); process.exit(0)`,
      { AGENTISTICS_JOURNAL: '1', AGENTISTICS_DIR: data, CLAUDE_DIR: claude },
    )
    expect(r.code).toBe(0)
    const file = JSON.parse(readFileSync(join(data, 'journal.db.status.json'), 'utf8')) as ShadowStatusFile
    expect(file.sinceBoot.counters.written).toBeGreaterThan(0)
    expect(file.runs).toBe(1)
  }, 60_000)
})
