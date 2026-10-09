import { describe, expect, test } from 'bun:test'
import {
  buildFleetFrame, closedPage, compactView, deltaBody, EMPTY_SENT, fleetEventsResponse, GAUGE_CPU_POINTS,
  GAUGE_RSS_BYTES, gaugesMoved, planFleetDelta,
  readClosedLimit, snapshotBody, windowOf, type FleetFrame, type FleetFramePayload,
} from './fleet-events'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetRow } from './fleet-row'

const row = (id: string, extra: Partial<ControlSession> = {}): ControlSession =>
  ({ id, title: id, harness: 'claude', cwd: '/w', state: 'waiting', ...extra }) as unknown as ControlSession
const fr = (id: string, extra: Partial<FleetRow> = {}): FleetRow =>
  ({ id, title: id, harness: 'claude', cwd: '/w', state: 'waiting', stateLabel: 'w', ...extra }) as unknown as FleetRow

function payload(rows: ControlSession[], extra: Partial<FleetFramePayload> = {}): FleetFramePayload {
  return { sessions: rows.map(r => fr(r.id, { title: r.title } as Partial<FleetRow>)), rows, attention: 0, tasks: [], finishedTasks: [], ...extra }
}

describe('windowOf', () => {
  test('keeps every non-closed row and the N most recent closed ones, in server order', () => {
    const rows = [
      row('a'), row('closed:1', { endedAt: 100 }), row('b'), row('closed:2', { endedAt: 300 }),
      row('closed:3', { endedAt: 200 }),
    ]
    const w = windowOf(rows, 2)
    expect(w.indexes.map(i => rows[i]!.id)).toEqual(['a', 'b', 'closed:2', 'closed:3'])
    expect(w.closedTotal).toBe(3)
  })

  test('closed=0 sends no closed row at all', () => {
    const rows = [row('a'), row('closed:1', { endedAt: 1 })]
    expect(windowOf(rows, 0).indexes).toEqual([0])
  })

  test('recency falls back to the last message, then to the start', () => {
    const rows = [row('closed:1', { startedAt: 500 }), row('closed:2', { lastUserMessageAt: 600 }), row('closed:3', { endedAt: 100 })]
    expect(windowOf(rows, 1).indexes.map(i => rows[i]!.id)).toEqual(['closed:2'])
  })
})

describe('planFleetDelta', () => {
  test('a PAGED closed row that changes (same count) bumps closedVersion — a meta-only delta', () => {
    const rows = (title: string) => [row('a'), row('closed:1', { endedAt: 100, title }), row('closed:2', { endedAt: 50 })]
    const f0 = buildFleetFrame(payload(rows('old')), 0)
    const sent = planFleetDelta(EMPTY_SENT, f0).next
    const f1 = buildFleetFrame(payload(rows('renamed')), 0)
    expect(f1.closedTotal).toBe(f0.closedTotal)
    const d = planFleetDelta(sent, f1)
    expect(d.empty).toBe(false)
    expect(d.delta.upsert).toEqual([])
    expect(Object.keys(d.delta.meta)).toEqual(['closedVersion'])
    // Nothing changed: no delta. And a re-order by recency is a change of the pages too.
    expect(planFleetDelta(d.next, buildFleetFrame(payload(rows('renamed')), 0)).empty).toBe(true)
    const reordered = [row('a'), row('closed:1', { endedAt: 100, title: 'renamed' }), row('closed:2', { endedAt: 500 })]
    expect(planFleetDelta(d.next, buildFleetFrame(payload(reordered), 0)).delta.meta.closedVersion).toBeDefined()
  })

  test('a WINDOWED closed row is upserted, and does not also invalidate the paged history', () => {
    const rows = (title: string) => [row('a'), row('closed:1', { endedAt: 100, title }), row('closed:2', { endedAt: 50 })]
    const sent = planFleetDelta(EMPTY_SENT, buildFleetFrame(payload(rows('old')), 1)).next
    const d = planFleetDelta(sent, buildFleetFrame(payload(rows('new')), 1))
    expect(d.delta.upsert).toEqual(['closed:1'])
    expect(d.delta.meta.closedVersion).toBeUndefined()
  })

  test('a GAUGE jitter re-sends nothing; a visible move re-sends the row with the current figures', () => {
    const MB = 1024 * 1024
    const at = (cpu: number, rss: number) => buildFleetFrame(payload([row('a', { cpuPercent: cpu, rssBytes: rss } as Partial<ControlSession>), row('b')]), 20)
    let sent = planFleetDelta(EMPTY_SENT, at(1, 400 * MB)).next
    // Every poll re-samples: small moves, in both directions, are not a change of the row.
    for (const [cpu, rss] of [[2, 401], [0.4, 399], [3.9, 430], [1, 410]] as const) {
      const p = planFleetDelta(sent, at(cpu, rss * MB))
      expect(p.empty).toBe(true)
      sent = p.next
    }
    // Drift is measured from what was SENT (1 %, 400 MB), so it still arrives once it adds up.
    const drift = planFleetDelta(sent, at(1, 465 * MB))
    expect(drift.delta.upsert).toEqual(['a'])
    const body = deltaBody(1, at(1, 465 * MB), drift.delta) as { upsert: { rows: Array<{ rssBytes: number }> } }
    expect(body.upsert.rows[0]!.rssBytes).toBe(465 * MB)
    const cpu = planFleetDelta(drift.next, at(1 + GAUGE_CPU_POINTS, 465 * MB))
    expect(cpu.delta.upsert).toEqual(['a'])
    // A real change still goes out at once, gauges or not.
    const st = planFleetDelta(cpu.next, buildFleetFrame(payload([row('a', { cpuPercent: 6, rssBytes: 465 * MB, state: 'working' } as Partial<ControlSession>), row('b')]), 20))
    expect(st.delta.upsert).toEqual(['a'])
  })

  test('gaugesMoved: no figure reads as 0 — a first sample is not a move, a large appearance is', () => {
    expect(gaugesMoved(undefined, { cpu: 1, rss: 1 })).toBe(true)
    expect(gaugesMoved({ cpu: null, rss: 5 }, { cpu: 0, rss: 5 })).toBe(false)
    expect(gaugesMoved({ cpu: null, rss: 5 }, { cpu: GAUGE_CPU_POINTS, rss: 5 })).toBe(true)
    expect(gaugesMoved({ cpu: undefined, rss: undefined }, { cpu: 0, rss: GAUGE_RSS_BYTES })).toBe(true)
    expect(gaugesMoved({ cpu: 1, rss: 5 }, { cpu: undefined, rss: 5 })).toBe(false)
    expect(gaugesMoved({ cpu: 1, rss: 5 }, { cpu: 1 + GAUGE_CPU_POINTS - 0.1, rss: 5 + GAUGE_RSS_BYTES - 1 })).toBe(false)
    expect(gaugesMoved({ cpu: undefined, rss: undefined }, { cpu: undefined, rss: undefined })).toBe(false)
  })

  test('the first plan upserts the window and sends every meta field', () => {
    const f = buildFleetFrame(payload([row('a'), row('b')], { attention: 1 }), 20)
    const { delta, empty } = planFleetDelta(EMPTY_SENT, f)
    expect(empty).toBe(false)
    expect(delta.upsert).toEqual(['a', 'b'])
    expect(delta.meta.attention).toBe(1)
  })

  test('an unchanged frame is an EMPTY delta', () => {
    const f = buildFleetFrame(payload([row('a'), row('b')]), 20)
    const once = planFleetDelta(EMPTY_SENT, f)
    const again = planFleetDelta(once.next, buildFleetFrame(payload([row('a'), row('b')]), 20))
    expect(again.empty).toBe(true)
  })

  test('one changed row is ONE upsert, nothing else', () => {
    const s = planFleetDelta(EMPTY_SENT, buildFleetFrame(payload([row('a'), row('b')]), 20)).next
    const d = planFleetDelta(s, buildFleetFrame(payload([row('a'), row('b', { state: 'working' })]), 20))
    expect(d.delta.upsert).toEqual(['b'])
    expect(d.delta.remove).toEqual([])
    expect(d.delta.order).toBeUndefined()
    expect(Object.keys(d.delta.meta)).toEqual([])
  })

  test('a row that left the fleet is removed; one that slid out of the closed window is NOT', () => {
    const before = [row('a'), row('closed:1', { endedAt: 1 }), row('closed:2', { endedAt: 2 })]
    const s = planFleetDelta(EMPTY_SENT, buildFleetFrame(payload(before), 2)).next
    // closed:3 is newer, so closed:1 slides out of a window of 2 — but still exists. `a` is gone.
    const after = [row('closed:1', { endedAt: 1 }), row('closed:2', { endedAt: 2 }), row('closed:3', { endedAt: 3 })]
    const d = planFleetDelta(s, buildFleetFrame(payload(after), 2))
    expect(d.delta.remove).toEqual(['a'])
    expect(d.delta.upsert).toEqual(['closed:3'])
    expect(d.next.rows.has('closed:1')).toBe(false)
  })

  test('a field that disappears is sent as null; a reorder sends order', () => {
    const s = planFleetDelta(EMPTY_SENT, buildFleetFrame(payload([row('a'), row('b')], { unavailable: 'x' }), 20)).next
    const d = planFleetDelta(s, buildFleetFrame(payload([row('b'), row('a')]), 20))
    expect(d.delta.meta.unavailable).toBeNull()
    expect(d.delta.order).toEqual(['b', 'a'])
    expect(d.delta.upsert).toEqual([])
  })
})

describe('bodies', () => {
  test('snapshot carries the window, the meta and the closed counts', () => {
    const f = buildFleetFrame(payload([row('a'), row('closed:1', { endedAt: 1 }), row('closed:2', { endedAt: 2 })]), 1)
    const b = snapshotBody(1, f) as { sessions: FleetRow[]; rows: ControlSession[]; closed: { total: number; sent: number } }
    expect(b.rows.map(r => r.id)).toEqual(['a', 'closed:2'])
    expect(b.sessions.map(r => r.id)).toEqual(['a', 'closed:2'])
    expect(b.closed).toEqual({ total: 2, sent: 1 })
    expect('closedTotal' in b).toBe(false)
  })

  test('a one-row delta is small', () => {
    const big = Array.from({ length: 300 }, (_, i) => row(`closed:${i}`, { endedAt: i }))
    const s = planFleetDelta(EMPTY_SENT, buildFleetFrame(payload([row('a'), ...big]), 20)).next
    const f2 = buildFleetFrame(payload([row('a', { state: 'working' }), ...big]), 20)
    const d = planFleetDelta(s, f2)
    expect(JSON.stringify(deltaBody(2, f2, d.delta)).length).toBeLessThan(2048)
  })

  test('the view travels compact: ids, not rows', () => {
    const v = compactView({
      groups: [{ key: 'p', label: 'P', rows: [fr('a'), fr('b')] }],
      shown: 2, total: 2, applied: { grouping: 'project', sort: 'recent', dir: 'desc' } as never,
      facets: [], groupings: [], sorts: [], scopes: [],
    } as never)
    expect(v.groups[0]!.ids).toEqual(['a', 'b'])
    expect('rows' in v.groups[0]!).toBe(false)
  })
})

describe('closedPage / readClosedLimit', () => {
  test('pages closed rows most recent first', () => {
    const p = payload([row('a'), row('closed:1', { endedAt: 1 }), row('closed:2', { endedAt: 2 }), row('closed:3', { endedAt: 3 })])
    const page = closedPage(p, 1, 1)
    expect(page.rows.map(r => r.id)).toEqual(['closed:2'])
    expect(page.total).toBe(3)
  })

  test('limit parsing', () => {
    expect(readClosedLimit(null)).toBe(20)
    expect(readClosedLimit('5')).toBe(5)
    expect(readClosedLimit('-1')).toBe(20)
    expect(readClosedLimit('9999')).toBe(200)
    expect(readClosedLimit('0')).toBe(0)
  })
})

describe('fleetEventsResponse', () => {
  async function readEvents(res: Response, n: number): Promise<Array<{ event: string; data: unknown }>> {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const out: Array<{ event: string; data: unknown }> = []
    while (out.length < n) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (ev && data) out.push({ event: ev, data: JSON.parse(data) })
      }
    }
    reader.releaseLock()
    return out
  }

  test('snapshot first, then only deltas, and nothing for an unchanged tick', async () => {
    let frame: FleetFrame = buildFleetFrame(payload([row('a')]), 20)
    let tick: (() => void) | null = null
    let unsubscribed = false
    const ctl = new AbortController()
    const res = fleetEventsResponse({
      frame: async () => frame,
      onTick: cb => { tick = cb; return () => { unsubscribed = true } },
      setTimer: () => 0, clearTimer: () => {},
    }, ctl.signal)!
    const first = await readEvents(res, 1)
    expect(first[0]!.event).toBe('snapshot')
    tick!() // unchanged: nothing
    frame = buildFleetFrame(payload([row('a', { state: 'working' })]), 20)
    tick!()
    const next = await readEvents(res, 1)
    expect(next[0]!.event).toBe('delta')
    expect((next[0]!.data as { seq: number; upsert: { rows: ControlSession[] } }).upsert.rows[0]!.state).toBe('working')
    expect((next[0]!.data as { seq: number }).seq).toBe(2)
    ctl.abort()
    expect(unsubscribed).toBe(true)
  })
})
