/**
 * The IO half: discovery over a sessions tree, `final` from the file's quiet time, and a LIVE rollout
 * read by what it wrote since last time — a resumed read plus the first one equals one whole read,
 * and a cold re-read (no cursor) re-derives the identical ids.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { collectRollouts, createCodexReplay, rolloutIdOf } from './index'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures/codex-replay/sessions')
const tmp = mkdtempSync(join(tmpdir(), 'codex-replay-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const settledNow = (path: string) => () => Math.floor(statSync(path).mtimeMs) + 120_000

describe('discover', () => {
  test('finds every rollout, under the UUID its filename carries', async () => {
    const replay = createCodexReplay({ sessionsDir: FIXTURES })
    const sources = await replay.discover()
    expect(sources.map(s => s.sessionId).sort()).toEqual([1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-00000000000${n}`))
    expect(sources[0]!.sourceRef).toMatch(/^codex:/)
  })

  test('a missing directory is an empty store, never an error', async () => {
    expect(await createCodexReplay({ sessionsDir: join(tmp, 'nope') }).discover()).toEqual([])
  })
})

describe('replay', () => {
  test('a settled rollout is closed; a live one holds its last turn and its ends', async () => {
    const path = (await collectRollouts(FIXTURES)).find(p => p.includes('000000000005'))!
    const source = { sessionId: rolloutIdOf(path), sourceRef: 'x' }
    const settled = await createCodexReplay({ sessionsDir: FIXTURES, now: settledNow(path) }).replay(source, null)
    expect(settled.events.some(e => e.type === 'session.ended')).toBe(true)
    const live = await createCodexReplay({ sessionsDir: FIXTURES, now: () => Math.floor(statSync(path).mtimeMs) }).replay(source, null)
    expect(live.events.some(e => e.type === 'session.ended')).toBe(false)
    // Its last turn is still open (no close) — but its usage is not held: `turn_aborted` proved it over.
    expect(live.events.filter(e => e.type === 'turn.ended').length)
      .toBe(settled.events.filter(e => e.type === 'turn.ended').length - 1)
    expect(live.events.filter(e => e.type === 'model.completed').length)
      .toBe(settled.events.filter(e => e.type === 'model.completed').length)
  })

  test('a live rollout read in two polls emits exactly what one whole read emits, and a cold re-read the same ids', async () => {
    const src = (await collectRollouts(FIXTURES)).find(p => p.includes('000000000001'))!
    const dir = join(tmp, 'live', '2026', '01', '01')
    cpSync(join(FIXTURES, '2026', '01', '01'), dir, { recursive: true })
    const path = join(dir, src.split('/').pop()!)
    const text = readFileSync(src, 'utf-8')
    const cut = text.indexOf('\n', Math.floor(text.length / 2)) + 1
    writeFileSync(path, text.slice(0, cut + 10)) // a partial trailing line: never consumed

    const source = { sessionId: rolloutIdOf(path), sourceRef: 'x' }
    let live = true
    const now = () => Math.floor(statSync(path).mtimeMs) + (live ? 0 : 120_000)
    const replay = createCodexReplay({ sessionsDir: join(tmp, 'live'), now })
    const first = await replay.replay(source, null)
    appendFileSync(path, text.slice(cut + 10))
    live = false
    const second = await replay.replay(source, first.cursor)

    const cold = await createCodexReplay({ sessionsDir: join(tmp, 'live'), now }).replay(source, null)
    const ids = (evs: AgentisticsEvent[]) => evs.map(e => e.eventId)
    expect([...ids(first.events), ...ids(second.events)]).toEqual(ids(cold.events))
    const whole = await createCodexReplay({ sessionsDir: FIXTURES, now: settledNow(src) }).replay({ sessionId: rolloutIdOf(src), sourceRef: 'x' }, null)
    expect(ids(cold.events)).toEqual(ids(whole.events))
  })

  test('an unknown rollout replays to nothing and hands the cursor back', async () => {
    const r = await createCodexReplay({ sessionsDir: FIXTURES }).replay({ sessionId: 'nope', sourceRef: 'x' }, 'c')
    expect(r).toEqual({ events: [], cursor: 'c' })
  })
})
