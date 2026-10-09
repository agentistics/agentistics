/** The fleet wire reducer, shared by browser, editor and cockpit. No harness-specific rules. */
export interface FleetWire {
  seq: number
  sessions: Array<{ id: string }>
  rows: Array<{ id: string }>
  [key: string]: unknown
}
export interface FleetWireDelta {
  seq: number
  upsert?: Pick<FleetWire, 'sessions' | 'rows'>
  remove?: string[]
  order?: string[]
  meta?: Record<string, unknown>
}

export function applyFleetWire(prev: FleetWire | null, event: string, body: unknown): FleetWire {
  const next = body as FleetWire & FleetWireDelta
  if (!next || !Number.isSafeInteger(next.seq) || next.seq < 1) throw new Error('Invalid fleet sequence')
  if (event === 'snapshot') {
    if (!Array.isArray(next.sessions) || !Array.isArray(next.rows)) throw new Error('Invalid fleet snapshot')
    return next
  }
  if (event !== 'delta' || !prev || next.seq !== prev.seq + 1) throw new Error('Fleet snapshot required')
  const merge = (held: Array<{ id: string }>, added: Array<{ id: string }> = []) => {
    const rows = new Map(held.map(r => [r.id, r]))
    for (const id of next.remove ?? []) rows.delete(id)
    for (const row of added) rows.set(row.id, row)
    const order = [...new Set([...(next.order ?? []), ...rows.keys()])]
    return order.flatMap(id => rows.has(id) ? [rows.get(id)!] : [])
  }
  const result: FleetWire = { ...prev, seq: next.seq, sessions: merge(prev.sessions, next.upsert?.sessions), rows: merge(prev.rows, next.upsert?.rows) }
  for (const [key, value] of Object.entries(next.meta ?? {})) {
    if (['seq', 'sessions', 'rows', '__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (value === null) delete result[key]
    else result[key] = value
  }
  return result
}

/** Expand the compact server view using the rows already received. */
export function expandFleetView(wire: FleetWire): FleetWire {
  const view = wire.view as { groups?: Array<{ ids?: string[]; [key: string]: unknown }> } | undefined
  if (!view?.groups) return wire
  const rows = new Map(wire.sessions.map(r => [r.id, r]))
  return { ...wire, view: { ...view, groups: view.groups.map(({ ids, ...group }) => ({ ...group, rows: (ids ?? []).flatMap(id => rows.has(id) ? [rows.get(id)!] : []) })) } }
}

/** Fetch-based SSE for hosts without EventSource (Node extension host and Bun cockpit).
 * A silent or incomplete connection expires; callers then use their existing poll fallback.
 */
export function followFleet(url: string, onFrame: (wire: FleetWire) => void, options: { history?: boolean; onBytes?: (bytes: number) => void; onEventBytes?: (event: string, bytes: number) => void } = {}): { loadClosed(): Promise<void>; healthy(): boolean; retryable(): boolean; close(): void } {
  const controller = new AbortController()
  let wire: FleetWire | null = null
  let at = Date.now()
  let closed = false
  let paging = false
  let pagedTotal: number | null = null
  let initialClosedSent = 0
  async function loadClosed(): Promise<void> {
    if (!wire || closed || paging) return
    paging = true
    try {
      let total = wire.closedTotal as number ?? (wire.closed as { total?: number } | undefined)?.total ?? 0
      // A new closed row is inserted at the beginning, shifting every page offset. Re-read the
      // paged part when the count changes so a closed=0 subscriber does not skip that new row.
      let offset = pagedTotal !== null && pagedTotal !== total ? initialClosedSent : (wire.closed as { sent?: number } | undefined)?.sent ?? 0
      const historyOrder = wire.rows.filter(r => r.id.startsWith('closed:')).slice(0, offset).map(r => r.id)
      while (offset < total && !closed) {
        const pageUrl = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href)
        pageUrl.pathname = '/api/fleet/closed'; pageUrl.searchParams.set('offset', String(offset)); pageUrl.searchParams.set('limit', '100')
        const res = await fetch(pageUrl, { signal: controller.signal })
        if (!res.ok) throw new Error('Closed fleet unavailable')
        const page = await res.json() as { sessions: FleetWire['sessions']; rows: FleetWire['rows']; total: number }
        if (!Array.isArray(page.rows) || !Array.isArray(page.sessions) || !page.rows.length) break
        total = page.total; offset += page.rows.length
        historyOrder.push(...page.rows.map(r => r.id))
        const merge = (old: FleetWire['rows'], added: FleetWire['rows']) => {
          const rows = new Map(old.map(r => [r.id, r]))
          for (const row of added) if (!rows.has(row.id)) rows.set(row.id, row)
          const paged = new Set(historyOrder)
          return [
            ...[...rows.values()].filter(r => !r.id.startsWith('closed:')),
            ...[...paged].flatMap(id => rows.has(id) ? [rows.get(id)!] : []),
            ...[...rows.values()].filter(r => r.id.startsWith('closed:') && !paged.has(r.id) && offset < total),
          ]
        }
        if (!wire || closed) return
        wire = { ...wire, sessions: merge(wire.sessions, page.sessions), rows: merge(wire.rows, page.rows), closed: { total, sent: offset } }
        onFrame(expandFleetView(wire))
      }
      if (total === 0 && wire.rows.some(r => r.id.startsWith('closed:'))) {
        wire = { ...wire, sessions: wire.sessions.filter(r => !r.id.startsWith('closed:')), rows: wire.rows.filter(r => !r.id.startsWith('closed:')), closed: { total: 0, sent: 0 } }
        onFrame(expandFleetView(wire))
      }
      pagedTotal = total
    } catch { controller.abort() }
    finally { paging = false }
  }
  const watchdog = setInterval(() => { if (Date.now() - at > 45_000) controller.abort() }, 5_000)
  void (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        options.onBytes?.(value.byteLength)
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let split: number
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2)
          const event = frame.split('\n').find(l => l.startsWith('event:'))?.slice(6).trim()
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
          if (event) options.onEventBytes?.(event, new TextEncoder().encode(frame + '\n\n').byteLength)
          if (event === 'ping') { at = Date.now(); continue }
          if (event !== 'snapshot' && event !== 'delta') continue
          wire = applyFleetWire(wire, event, JSON.parse(data))
          if (event === 'snapshot') { initialClosedSent = (wire.closed as { sent?: number } | undefined)?.sent ?? 0; pagedTotal = null }
          at = Date.now()
          if (!closed) { onFrame(expandFleetView(wire)); if (options.history) void loadClosed() }
        }
        if (buffer.length > 8 * 1024 * 1024) throw new Error('Fleet frame too large')
      }
    } catch { /* The caller retains the last fleet and polls until it can reopen. */ }
    finally { closed = true; controller.abort(); clearInterval(watchdog) }
  })()
  return { loadClosed, retryable: () => closed, healthy: () => !closed && wire !== null && Date.now() - at < 45_000, close: () => { closed = true; controller.abort(); clearInterval(watchdog) } }
}
