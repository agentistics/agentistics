/**
 * LIVE.12S — a catch-up pass must hand the event loop back BETWEEN pages.
 *
 * Every `await` inside the pass resolves from a cache or a synchronous SQLite call, i.e. as a
 * MICROTASK, so a pass of 50 pages ran start to finish without a single timer, socket or HTTP request
 * getting a turn: on a machine whose projections were rebuilding that froze the whole server for ~3 s
 * on the first `/api/runtime/metrics` request the app makes at boot, and the Live page waited behind it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openJournal } from '../journal/journal'
import { STORED_PROJECTIONS } from './catalog'
import { catchUpProjections } from './catch-up'
import { fixtureEvents } from './synthetic-events'
import { openProjectionStore } from './store'

const ON = { AGENTISTICS_PROJECTIONS: '1' }
const ROOT = mkdtempSync(join(tmpdir(), 'agentistics-live12s-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('catch-up yields to the event loop', () => {
  test('a timer-driven task runs between pages, not only after the whole pass', async () => {
    const events = await fixtureEvents()
    const journal = await openJournal({ path: join(ROOT, 'journal.db'), scheduleCheckpoint: () => () => {} })
    for (let i = 0; i < events.length; i += 97) await journal.append(events.slice(i, i + 97))
    const store = await openProjectionStore({ path: join(ROOT, 'projections.db'), projections: STORED_PROJECTIONS })

    let ticks = 0
    let running = true
    const pump = () => { if (!running) return; ticks++; setImmediate(pump) }
    setImmediate(pump)

    const report = await catchUpProjections({ journal, store, env: ON, pageSize: 7, adapterVersions: {} })
    running = false

    expect(report.state).toBe('done')
    expect(report.pages).toBeGreaterThan(5)
    // One macrotask turn per committed page, at least: with only microtask awaits this stays 0.
    expect(ticks).toBeGreaterThanOrEqual(report.pages)
    store.close()
    journal.close()
  })
})
