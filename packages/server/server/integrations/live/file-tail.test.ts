/**
 * file-tail.test.ts — the file-tail floor against a REAL journal (bun:sqlite on a temp dir) and the
 * REAL Claude replay over a disposable projects tree built from a redacted real transcript. The
 * replay's clock is injected and never reaches the settle window, so no `*.ended` and no subagent
 * pass muddies the comparison: what is compared is exactly the fold the tail and the build share.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { createClaudeReplay } from '../claude'
import type { HarnessReplay, ReplayCursor } from '../types'
import { openJournal } from '../../journal/journal'
import type { Journal } from '../../journal/types'
import { claudeStamps, createShadow, type SourceStamp, type ShadowStatusFile } from '../../journal/shadow'
import { MAX_STATES } from '../../transcript-state'
import {
  asObserved, createFileTail, LIVE_MAX_SOURCES, nextBaseline, planTail, type TailAppendResult,
} from './file-tail'

const CONV = '00000000-0000-4000-8000-000000000001'
const FIXTURE = join(import.meta.dir, '../../../test/fixtures/claude-replay/proj', `${CONV}.jsonl`)
/** Complete lines, each WITH its newline. */
const LINES = readFileSync(FIXTURE, 'utf-8').split('\n').filter(l => l.length > 0).map(l => `${l}\n`)

let root = ''
let seq = 0
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-filetail-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** Never reaches the replay's 60 s settle window for a file written during the test. */
const CLOCK = Date.now()
const now = () => CLOCK

async function world(initial: string) {
  const base = join(root, `w${++seq}`)
  const projectsDir = join(base, 'projects')
  await mkdir(join(projectsDir, 'proj'), { recursive: true })
  const file = join(projectsDir, 'proj', `${CONV}.jsonl`)
  await writeFile(file, initial)
  const journal = await openJournal({ path: join(base, 'journal.db') })
  return { base, projectsDir, file, journal }
}

/** The shadow's accepted rule, over a real journal, recording what it was handed. */
function appendTo(j: Journal, sink?: AgentisticsEvent[]) {
  return async (events: readonly AgentisticsEvent[]): Promise<TailAppendResult> => {
    const dropped = j.status().counters.dropped
    const r = await j.append(events)
    sink?.push(...events)
    return { written: r.written, duplicates: r.duplicates, rejected: r.rejected.length, accepted: j.status().counters.dropped === dropped }
  }
}

function tailOver(w: { projectsDir: string; journal: Journal }, sink?: AgentisticsEvent[], replay?: HarnessReplay) {
  const cursors = new Map<string, ReplayCursor>()
  const tail = createFileTail({
    readStamps: () => claudeStamps(w.projectsDir),
    replay: replay ?? createClaudeReplay({ projectsDir: w.projectsDir, now }),
    append: appendTo(w.journal, sink),
    getCursor: id => cursors.get(id) ?? null,
    setCursor: (id, c) => { cursors.set(id, c) },
    warn: () => {},
  })
  return { tail, cursors }
}

/** A fresh replay instance — no retained walk — over the file as it is now. */
async function freshReplay(projectsDir: string): Promise<AgentisticsEvent[]> {
  const r = createClaudeReplay({ projectsDir, now })
  const [src] = (await r.discover()).filter(s => s.sessionId === CONV)
  return (await r.replay(src!, null)).events
}

const ids = (events: readonly AgentisticsEvent[]) => [...new Set(events.map(e => e.eventId))].sort()
const stamp = (key: string, mtimeMs: number): SourceStamp => ({ key, mtimeMs })

describe('planTail (pure)', () => {
  test('the first tick is a baseline: nothing is read', () => {
    const cur = new Map([['a', stamp('1', 10)]])
    expect(planTail(null, cur, { maxSources: 8 })).toEqual({ tail: [], deferred: [], baseline: true })
  })

  test('only a changed or new source is a candidate', () => {
    const prev = new Map([['a', stamp('1', 10)], ['b', stamp('1', 10)]])
    const cur = new Map([['a', stamp('1', 10)], ['b', stamp('2', 20)], ['c', stamp('1', 5)]])
    expect(planTail(prev, cur, { maxSources: 8 })).toEqual({ tail: ['b', 'c'], deferred: [], baseline: false })
  })

  test('the cap keeps the newest, in a TOTAL order (ties broken by id, never by insertion)', () => {
    const cur = new Map([['d', stamp('x', 5)], ['b', stamp('x', 9)], ['c', stamp('x', 9)], ['a', stamp('x', 1)]])
    const plan = planTail(new Map(), cur, { maxSources: 2 })
    expect(plan.tail).toEqual(['b', 'c'])
    expect(plan.deferred).toEqual(['d', 'a'])
    const reversed = new Map([...cur].reverse())
    expect(planTail(new Map(), reversed, { maxSources: 2 })).toEqual(plan)
  })

  test('a deferred source keeps its previous stamp, so it is a candidate again next tick', () => {
    const prev = new Map([['a', stamp('1', 1)], ['b', stamp('1', 1)]])
    const cur = new Map([['a', stamp('2', 2)], ['b', stamp('2', 3)], ['n', stamp('1', 1)]])
    const plan = planTail(prev, cur, { maxSources: 1 })
    expect(plan.tail).toEqual(['b'])
    const next = nextBaseline(prev, cur, plan.deferred)
    expect(next.get('a')).toEqual(stamp('1', 1)) // the old one
    expect(next.has('n')).toBe(false) // had none: absent, still "new"
    expect(next.get('b')).toEqual(stamp('2', 3))
    expect(planTail(next, cur, { maxSources: 8 }).tail).toEqual(['a', 'n'])
  })

  test('the cap stays far below the replay walk memory, so the tail and the build cannot evict each other', () => {
    expect(LIVE_MAX_SOURCES * 4).toBeLessThanOrEqual(MAX_STATES)
  })
})

describe('asObserved', () => {
  test('changes the mode and nothing else — the id included', async () => {
    const [e] = await freshReplay(join(import.meta.dir, '../../../test/fixtures/claude-replay'))
    const o = asObserved(e!)
    expect(e!.provenance.mode).toBe('replayed')
    expect(o.provenance.mode).toBe('observed')
    expect(o.eventId).toBe(e!.eventId)
    expect({ ...o, provenance: { ...o.provenance, mode: 'replayed' } }).toEqual(e!)
  })
})

describe('the tail converges with the replay', () => {
  test('tail first, then a cold replay of the whole file writes NOTHING new — and the id sets are identical', async () => {
    const w = await world(LINES.slice(0, 30).join(''))
    const seen: AgentisticsEvent[] = []
    const { tail } = tailOver(w, seen)
    expect((await tail.tick()).status).toBe('baseline')
    expect(seen).toHaveLength(0)

    for (const [from, to] of [[30, 47], [47, 150], [150, LINES.length]] as const) {
      await appendFile(w.file, LINES.slice(from, to).join(''))
      const t = await tail.tick()
      expect(t.status).toBe('ran')
      if (t.status === 'ran') { expect(t.tailed).toBe(1); expect(t.failed).toBe(0) }
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(e => e.provenance.mode === 'observed')).toBe(true)
    expect(tail.stats().written).toBeGreaterThan(0)

    const replayed = await freshReplay(w.projectsDir)
    const r = await w.journal.append(replayed)
    expect(r.written).toBe(0)
    expect(r.duplicates).toBe(replayed.length)
    expect(ids(seen)).toEqual(ids(replayed))
    w.journal.close()
  })

  test('replay first, then the tail writes NOTHING new', async () => {
    const w = await world(LINES.slice(0, 20).join(''))
    const seen: AgentisticsEvent[] = []
    const { tail } = tailOver(w, seen)
    await tail.tick() // baseline
    await appendFile(w.file, LINES.slice(20).join(''))
    const replayed = await freshReplay(w.projectsDir)
    expect((await w.journal.append(replayed)).written).toBeGreaterThan(0)

    const t = await tail.tick()
    expect(t.status).toBe('ran')
    if (t.status === 'ran') {
      expect(t.written).toBe(0)
      expect(t.duplicates).toBe(t.events)
      expect(t.events).toBeGreaterThan(0)
    }
    expect(ids(seen)).toEqual(ids(replayed))
    w.journal.close()
  })

  test('a partial trailing line is not consumed until it is completed', async () => {
    // Find a line that produces events of its own, so its absence is observable.
    let k = 10
    for (; k < LINES.length - 1; k++) {
      const a = await world(LINES.slice(0, k).join(''))
      const b = await world(LINES.slice(0, k + 1).join(''))
      const more = ids(await freshReplay(b.projectsDir)).length > ids(await freshReplay(a.projectsDir)).length
      a.journal.close(); b.journal.close()
      if (more) break
    }
    const before = await world(LINES.slice(0, k).join(''))
    const after = await world(LINES.slice(0, k + 1).join(''))
    const expectBefore = ids(await freshReplay(before.projectsDir))
    const expectAfter = ids(await freshReplay(after.projectsDir))
    before.journal.close(); after.journal.close()

    const w = await world(LINES.slice(0, k).join(''))
    const seen: AgentisticsEvent[] = []
    const { tail } = tailOver(w, seen)
    await tail.tick() // baseline
    const line = LINES[k]!
    const cut = Math.floor(line.length / 2)
    await appendFile(w.file, line.slice(0, cut))
    const half = await tail.tick()
    expect(half.status).toBe('ran')
    expect(ids(seen)).toEqual(expectBefore)

    await appendFile(w.file, line.slice(cut))
    await tail.tick()
    expect(ids(seen)).toEqual(expectAfter)
    w.journal.close()
  })
})

describe('the tail itself', () => {
  test('discover() is called only for an id it does not already know', async () => {
    const w = await world(LINES.slice(0, 10).join(''))
    const inner = createClaudeReplay({ projectsDir: w.projectsDir, now })
    let discovers = 0
    const spy: HarnessReplay = { discover: () => { discovers++; return inner.discover() }, replay: (s, c) => inner.replay(s, c) }
    const { tail } = tailOver(w, undefined, spy)
    await tail.tick()
    await appendFile(w.file, LINES.slice(10, 20).join(''))
    await tail.tick()
    await appendFile(w.file, LINES.slice(20, 30).join(''))
    await tail.tick()
    expect(discovers).toBe(1)
    w.journal.close()
  })

  test('a tick that finds one running is busy, and one failing source costs that source only', async () => {
    const stamps = new Map([['a', stamp('1', 1)], ['b', stamp('1', 1)]])
    let release: () => void = () => {}
    let gate: Promise<void> | null = null
    const replayed: string[] = []
    const cursors = new Map<string, ReplayCursor>()
    let failA = true
    const tail = createFileTail({
      readStamps: async () => { if (gate) await gate; return new Map(stamps) },
      replay: {
        discover: async () => [{ sessionId: 'a', sourceRef: 'x:a' }, { sessionId: 'b', sourceRef: 'x:b' }],
        replay: async src => {
          replayed.push(src.sessionId)
          if (src.sessionId === 'a' && failA) throw new Error('boom')
          return { events: [], cursor: `c-${src.sessionId}` }
        },
      },
      append: async () => ({ written: 0, duplicates: 0, rejected: 0, accepted: true }),
      getCursor: id => cursors.get(id) ?? null,
      setCursor: (id, c) => { cursors.set(id, c) },
      warn: () => {},
    })
    await tail.tick() // baseline
    stamps.set('a', stamp('2', 2)); stamps.set('b', stamp('2', 2))
    gate = new Promise(r => { release = r })
    const first = tail.tick()
    expect(await tail.tick()).toEqual({ status: 'busy' })
    release(); gate = null
    const t = await first
    expect(t.status === 'ran' && t.failed).toBe(1)
    expect(cursors.get('b')).toBe('c-b')
    expect(cursors.has('a')).toBe(false)
    // `a` kept its previous stamp: it is tried again without having changed; `b` is not.
    failA = false
    replayed.length = 0
    await tail.tick()
    expect(replayed).toEqual(['a'])
    expect(cursors.get('a')).toBe('c-a')
    expect(tail.stats().busy).toBe(1)
  })

  test('an append that dropped anything leaves the cursor where it was', async () => {
    const stamps = new Map([['a', stamp('1', 1)]])
    const cursors = new Map<string, ReplayCursor>()
    const accepted: string[] = []
    const tail = createFileTail({
      readStamps: async () => new Map(stamps),
      replay: {
        discover: async () => [{ sessionId: 'a', sourceRef: 'x:a' }],
        replay: async () => ({ events: [{ eventId: 'e' } as unknown as AgentisticsEvent], cursor: 'next' }),
      },
      append: async () => ({ written: 0, duplicates: 0, rejected: 0, accepted: false }),
      getCursor: id => cursors.get(id) ?? null,
      setCursor: (id, c) => { cursors.set(id, c) },
      onAccepted: id => { accepted.push(id) },
      warn: () => {},
    })
    await tail.tick()
    stamps.set('a', stamp('2', 2))
    await tail.tick()
    expect(cursors.has('a')).toBe(false)
    expect(accepted).toEqual([])
  })

  test('start() arms one unref\'d timer and stop() clears it', () => {
    const armed: { unrefd: boolean }[] = []
    let cleared = 0
    const tail = createFileTail({
      readStamps: async () => new Map(),
      replay: { discover: async () => [], replay: async () => ({ events: [], cursor: null }) },
      append: async () => ({ written: 0, duplicates: 0, rejected: 0, accepted: true }),
      getCursor: () => null,
      setCursor: () => {},
      setInterval: () => { const h = { unrefd: false, unref() { h.unrefd = true } }; armed.push(h); return h },
      clearInterval: () => { cleared++ },
    })
    tail.start(); tail.start()
    expect(armed).toHaveLength(1)
    expect(armed[0]!.unrefd).toBe(true)
    tail.stop(); tail.stop()
    expect(cleared).toBe(1)
  })
})

describe('inside the shadow', () => {
  test('the live tail and the build share ONE cursor per conversation', async () => {
    const w = await world(LINES.slice(0, 40).join(''))
    const inner = createClaudeReplay({ projectsDir: w.projectsDir, now })
    let coldReads = 0
    const spy: HarnessReplay = {
      discover: () => inner.discover(),
      replay: (s, c) => { if (c === null) coldReads++; return inner.replay(s, c) },
    }
    const statusPath = join(w.base, 'status.json')
    const shadow = createShadow({
      enabled: true, liveEnabled: true, open: async () => w.journal, replay: spy,
      stamps: () => claudeStamps(w.projectsDir), statusPath, stampsPath: null, registerStatus: () => {}, now,
    })
    const first = await shadow.ingest([{ session_id: CONV }])
    expect(first.status === 'ran' && first.written).toBeGreaterThan(0)
    expect(coldReads).toBe(1)

    const tail = shadow.startLive({ autoStart: false })
    expect(tail).not.toBeNull()
    expect(shadow.startLive({ autoStart: false })).toBe(tail) // idempotent
    await tail!.tick() // baseline
    await appendFile(w.file, LINES.slice(40, 90).join(''))
    const t = await tail!.tick()
    expect(t.status === 'ran' && t.written).toBeGreaterThan(0)
    expect(coldReads).toBe(1) // resumed from the build's cursor

    await appendFile(w.file, LINES.slice(90, 140).join(''))
    const again = await shadow.ingest([{ session_id: CONV }])
    expect(again.status === 'ran' && again.written).toBeGreaterThan(0)
    expect(coldReads).toBe(1) // and the build resumed from the tail's

    const file = JSON.parse(readFileSync(statusPath, 'utf8')) as ShadowStatusFile
    expect(file.live?.ticks).toBe(2)
    expect(file.live?.written).toBeGreaterThan(0)

    shadow.close()
    expect(shadow.startLive({ autoStart: false })).not.toBe(tail) // close() stopped it
    shadow.stopLive()
  })

  test('live off: startLive starts nothing', async () => {
    const w = await world(LINES.slice(0, 5).join(''))
    const off = createShadow({ enabled: true, liveEnabled: false, open: async () => w.journal, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    expect(off.startLive({ autoStart: false })).toBeNull()
    const journalOff = createShadow({ enabled: false, liveEnabled: true, open: async () => w.journal, stamps: () => claudeStamps(w.projectsDir), statusPath: null, registerStatus: () => {} })
    expect(journalOff.startLive({ autoStart: false })).toBeNull()
    w.journal.close()
  })
})
