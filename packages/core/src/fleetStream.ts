/** The fleet wire reducer, shared by browser, editor and cockpit. No harness-specific rules. */
export interface FleetWire {
  seq: number
  closedVersion?: string
  sessions: Array<{ id: string }>
  rows: Array<{ id: string }>
  verbCatalog?: Array<Array<Record<string, unknown>>>
  [key: string]: unknown
}
export interface FleetWireDelta {
  seq: number
  upsert?: { sessions?: FleetWire['sessions']; rows?: FleetWire['rows']; verbCatalog?: FleetWire['verbCatalog'] }
  remove?: string[]
  order?: string[]
  meta?: Record<string, unknown>
}

function attachCommand(row: Record<string, unknown>): string {
  return row.harness === 'agentistics' ? '' : `agentop session attach ${String(row.id ?? '').slice(0, 12)}`
}

/** Materialize compact stream rows before storing them, so keys never survive into a later delta. */
function expandRows(rows: FleetWire['sessions'], catalog?: FleetWire['verbCatalog']): FleetWire['sessions'] {
  return rows.map(row => {
    const source = row as Record<string, unknown>
    const key = source.verbKey
    const verbs = typeof key === 'number' ? catalog?.[key] : undefined
    const compact = typeof key === 'number' || Array.isArray(catalog)
    if (!compact) return row
    const { verbKey: _verbKey, ...withoutKey } = source
    return {
      ...withoutKey,
      ...(verbs ? { verbs } : {}),
      ...(compact && !('attachCommand' in withoutKey) ? { attachCommand: attachCommand(withoutKey) } : {}),
    }
  }) as FleetWire['sessions']
}

export function applyFleetWire(prev: FleetWire | null, event: string, body: unknown): FleetWire {
  const next = body as FleetWire & FleetWireDelta
  if (!next || !Number.isSafeInteger(next.seq) || next.seq < 1) throw new Error('Invalid fleet sequence')
  if (event === 'snapshot') {
    if (!Array.isArray(next.sessions) && !Array.isArray(next.rows)) throw new Error('Invalid fleet snapshot')
    const compactSessions = Array.isArray(next.sessions) ? next.sessions : next.rows!
    const sessions = expandRows(compactSessions, next.verbCatalog)
    const hasLegacyRows = Array.isArray(next.rows)
    const { rows: _legacyRows, ...withoutRows } = next
    const result = { ...withoutRows, sessions } as FleetWire
    result.rows = hasLegacyRows && !Array.isArray(next.verbCatalog) ? next.rows! : sessions
    return result
  }
  if (event !== 'delta' || !prev || next.seq !== prev.seq + 1) throw new Error('Fleet snapshot required')
  const merge = (held: Array<{ id: string }>, added: Array<{ id: string }> = []) => {
    const rows = new Map(held.map(r => [r.id, r]))
    for (const id of next.remove ?? []) rows.delete(id)
    for (const row of added) rows.set(row.id, row)
    const order = [...new Set([...(next.order ?? []), ...rows.keys()])]
    return order.flatMap(id => rows.has(id) ? [rows.get(id)!] : [])
  }
  const { rows: _legacyRows, ...withoutRows } = prev
  const added = expandRows(next.upsert?.sessions ?? next.upsert?.rows ?? [], next.upsert?.verbCatalog ?? prev.verbCatalog)
  const result = { ...withoutRows, seq: next.seq, sessions: merge(prev.sessions, added) } as FleetWire
  result.rows = merge(prev.rows, added)
  for (const [key, value] of Object.entries(next.meta ?? {})) {
    if (['seq', 'sessions', 'rows', '__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (value === null) delete result[key]
    else result[key] = value
  }
  return result as unknown as FleetWire
}

/** Expand the compact verb catalogue before any host-specific consumer sees the rows. */
export function expandFleetVerbs(wire: FleetWire): FleetWire {
  const sessions = expandRows(wire.sessions, wire.verbCatalog)
  const result = { ...wire, sessions }
  result.rows = sessions
  return result as unknown as FleetWire
}

/** The row is over, not merely idle: a closed history row, or an exited / lost session. */
export function historicalWireRow(row: { id: string; state?: unknown }): boolean {
  return row.id.startsWith('closed:') || row.state === 'closed' || row.state === 'exited' || row.state === 'lost'
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
  let pagedVersion: string | undefined | null = null
  let pagedEnd = 0
  let historyOpened = false
  let refreshPending = false
  let pagingVersion: string | undefined
  let pagingTotal = 0
  let initialClosedSent = 0
  const closedTotal = () => wire?.closedTotal as number ?? (wire?.closed as { total?: number } | undefined)?.total ?? 0
  async function loadClosed(refreshOnly = false): Promise<void> {
    if (!wire || closed) return
    historyOpened = true
    if (paging) {
      if (!refreshOnly || wire.closedVersion !== pagingVersion || closedTotal() !== pagingTotal) refreshPending = true
      return
    }
    paging = true
    try {
      let total = closedTotal()
      const closedTotalAtStart = total
      const version = wire.closedVersion
      pagingVersion = version; pagingTotal = total
      const invalidated = pagedTotal !== null && (pagedTotal !== total || pagedVersion !== version)
      // The version covers closed rows outside the SSE window, including same-count edits and
      // page ordering. Refresh only pages already opened; a closed history makes no page GETs.
      let offset = Math.min(total, invalidated ? initialClosedSent : (wire.closed as { sent?: number } | undefined)?.sent ?? 0)
      const end = refreshOnly && pagedTotal !== null ? pagedEnd : Infinity
      const historyOrder = wire.rows.filter(historicalWireRow).slice(0, offset).map(r => r.id)
      const before = wire
      const sessions: FleetWire['sessions'] = []
      while (offset < Math.min(total, end) && !closed) {
        const pageUrl = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href)
        pageUrl.pathname = '/api/fleet/closed'; pageUrl.searchParams.set('offset', String(offset)); pageUrl.searchParams.set('limit', '100')
        const res = await fetch(pageUrl, { signal: controller.signal })
        if (!res.ok) throw new Error('Closed fleet unavailable')
        const page = await res.json() as { sessions?: FleetWire['sessions']; rows?: FleetWire['rows']; verbCatalog?: FleetWire['verbCatalog']; total: number }
        if (!wire || closed) return
        if (wire.closedVersion !== version || closedTotal() !== closedTotalAtStart) { refreshPending = true; return }
        const pageSessionsRaw = Array.isArray(page.sessions) ? page.sessions : page.rows
        if (!Array.isArray(pageSessionsRaw)) throw new Error('Invalid closed fleet page')
        const pageSessions = expandRows(pageSessionsRaw, page.verbCatalog)
        total = page.total
        if (!pageSessions.length) break
        offset += pageSessions.length
        sessions.push(...pageSessions)
        historyOrder.push(...pageSessions.map(r => r.id))
      }
      if (!wire || closed) return
      const merge = (held: FleetWire['rows'], added: FleetWire['rows'], prior: FleetWire['rows']) => {
        const current = new Map(held.map(r => [r.id, r]))
        const original = new Map(prior.map(r => [r.id, r]))
        // Replace paged facts, but retain a newer SSE upsert received during this GET.
        for (const row of added) if (!current.has(row.id) || current.get(row.id) === original.get(row.id)) current.set(row.id, row)
        return [
          ...[...current.values()].filter(r => !historicalWireRow(r)),
          ...[...new Set(historyOrder)].flatMap(id => current.has(id) ? [current.get(id)!] : []),
        ]
      }
      if (sessions.length || invalidated || total === 0 && wire.rows.some(historicalWireRow)) {
        wire = { ...wire, sessions: merge(wire.sessions, sessions, before.sessions), closed: { total, sent: offset } }
        wire.rows = wire.sessions
          onFrame(expandFleetView(expandFleetVerbs(wire)))
      }
      pagedTotal = total
      pagedVersion = version
      pagedEnd = Math.max(pagedEnd, initialClosedSent + Math.ceil((offset - initialClosedSent) / 100) * 100)
    } catch { controller.abort() }
    finally {
      paging = false
      if (refreshPending && !closed && !controller.signal.aborted) {
        refreshPending = false
        void loadClosed(pagedTotal !== null)
      }
    }
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
          if (event === 'snapshot') { initialClosedSent = (wire.closed as { sent?: number } | undefined)?.sent ?? 0; pagedTotal = null; pagedVersion = null; pagedEnd = initialClosedSent }
          at = Date.now()
          if (!closed) { onFrame(expandFleetView(expandFleetVerbs(wire))); if (options.history || historyOpened) void loadClosed(true) }
        }
        if (buffer.length > 8 * 1024 * 1024) throw new Error('Fleet frame too large')
      }
    } catch { /* The caller retains the last fleet and polls until it can reopen. */ }
    finally { closed = true; controller.abort(); clearInterval(watchdog) }
  })()
  return { loadClosed, retryable: () => closed, healthy: () => !closed && wire !== null && Date.now() - at < 45_000, close: () => { closed = true; controller.abort(); clearInterval(watchdog) } }
}
