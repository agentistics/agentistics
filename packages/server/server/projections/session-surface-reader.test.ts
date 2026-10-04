/**
 * session-surface-reader.test.ts — the keyed read over a REAL store built by the real catch-up:
 * a conversation is found by (harness, conversation id), another is not, and a store that is not built
 * (or not open) is "not ready", never "empty".
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { openJournal } from '../journal/journal'
import { STORED_PROJECTIONS } from './catalog'
import { catchUpProjections } from './catch-up'
import { readSessionSurface, sessionSurfaceReady } from './session-surface-reader'
import { fixtureEvents } from './synthetic-events'
import { openProjectionStore } from './store'

const ROOT = mkdtempSync(join(tmpdir(), 'agentistics-live2-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })
const EVENTS = await fixtureEvents()
const runs = EVENTS.filter(e => e.type === 'run.started') as AgentisticsEvent<'run.started'>[]

describe('the keyed read', () => {
  test('not ready before the first build; ready and exact after it', async () => {
    const j = await openJournal({ path: join(ROOT, 'journal.db'), scheduleCheckpoint: () => () => {} })
    for (let i = 0; i < EVENTS.length; i += 97) await j.append(EVENTS.slice(i, i + 97))
    const store = await openProjectionStore({ path: join(ROOT, 'projections.db'), projections: STORED_PROJECTIONS })
    expect(sessionSurfaceReady(store)).toBe(false)
    await catchUpProjections({ journal: j, store, env: { AGENTISTICS_PROJECTIONS: '1' }, adapterVersions: { claude: '1.0.0', codex: '1.0.0' } })
    expect(sessionSurfaceReady(store)).toBe(true)

    const r = runs.find(x => x.data.conversationId)!
    const row = readSessionSurface(store, r.data.harness, r.data.conversationId!)
    expect(row).toMatchObject({ harness: r.data.harness, conversationId: r.data.conversationId })
    expect(row!.turns).toBeGreaterThanOrEqual(0)
    expect(readSessionSurface(store, r.data.harness, 'a-conversation-the-journal-never-saw')).toBeNull()
    expect(readSessionSurface(store, 'gemini', r.data.conversationId!)).toBeNull()

    store.close()
    expect(sessionSurfaceReady(store)).toBe(false)
    expect(readSessionSurface(store, r.data.harness, r.data.conversationId!)).toBeNull()
    j.close()
  })
})
