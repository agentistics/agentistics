/**
 * native.ts — H22: the NATIVE Agentistics sessions in the editor (A4.5 brought only their cost).
 *
 * The native harness is experimental (owner decision 2026-10-03): the editor shows these sessions only
 * where the server says the native runtime may be shown — `GET /api/engine` with an engine that
 * provides it AND `nativeExperimental` — the same rule as the web. An older server that does not say
 * reads as hidden. Opening one opens its chat in the web app: the conversation lives there.
 */
export type NativeActivity = 'working' | 'waiting-approval' | 'waiting' | 'exited'

export interface NativeRow {
  id: string
  title: string
  model: string
  status: string
  activity?: NativeActivity
  updatedAt: string
}

/** The web's own rule (`nativeRuntimeFrom`). */
export function nativeVisible(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const s = status as { present?: unknown; nativeExperimental?: unknown; manifest?: { provides?: { nativeRuntime?: unknown } } }
  return s.present === true && s.manifest?.provides?.nativeRuntime === true && s.nativeExperimental === true
}

const ACTIVITIES: ReadonlySet<string> = new Set(['working', 'waiting-approval', 'waiting', 'exited'])

/** `GET /api/runtime/sessions`' answer → the rows the list draws (a person's sessions, newest first). */
export function nativeRowsFrom(body: unknown): NativeRow[] {
  const sessions = (body as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(sessions)) return []
  const out: NativeRow[] = []
  for (const raw of sessions) {
    const s = raw as Record<string, unknown>
    if (typeof s.sessionId !== 'string' || s.lineage) continue
    out.push({
      id: s.sessionId,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : 'Agentistics',
      model: typeof s.model === 'string' ? s.model : '',
      status: typeof s.status === 'string' ? s.status : 'open',
      ...(typeof s.activity === 'string' && ACTIVITIES.has(s.activity) ? { activity: s.activity as NativeActivity } : {}),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    })
  }
  return out
}

/** How many native sessions wait on the person — counted beside the fleet's attention. */
export function nativeAttention(rows: readonly NativeRow[]): number {
  return rows.filter(r => r.status === 'open' && (r.activity === 'waiting' || r.activity === 'waiting-approval')).length
}

/** The web page a native session opens to. */
export function nativeSessionUrl(api: string, id: string): string {
  return `${api.replace(/\/+$/, '')}/sessions/${encodeURIComponent(id)}`
}
