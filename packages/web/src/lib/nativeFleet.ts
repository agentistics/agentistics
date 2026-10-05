/**
 * nativeFleet.ts — the I/O half of folding NATIVE sessions into the fleet (UI.UNIFY). The pure half
 * is `nativeFleetRow.ts`; this file only asks the engine and the board, and routes the row verbs a
 * native id can take to the engine's own routes.
 *
 * Gated exactly like every other native surface (`nativeRuntimeFrom`): no engine, or the
 * experimental flag off, and the fleet carries no native row at all — an entry that can only fail is
 * not an option.
 */
import { CREATE_URL, nativeRuntimeFrom, refusalSentence } from './nativeSession'
import { nativeFleetEntries, type NativeFilingFacts, type NativeListRecord } from './nativeFleetRow'
import type { FleetRow } from './fleet'
import { onEngineCapsInvalidated } from './engineCapsBus'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

let gate: Promise<boolean> | null = null

onEngineCapsInvalidated(() => { gate = null })

/** The engine's answer is fixed for a server's lifetime unless the experimental switch moves it; asked once per page load. */
function nativeOn(): Promise<boolean> {
  gate ??= fetch('/api/engine')
    .then(r => (r.ok ? r.json() : null))
    .then(nativeRuntimeFrom)
    .catch(() => false)
  return gate
}

/** How many native sessions the list carries — the engine's newest, like the aside used to read. */
const NATIVE_LIST_LIMIT = 50

export interface NativeFleet { rows: FleetRow[]; sessions: ControlSession[]; measuredWaiting: string[] }

const NONE: NativeFleet = { rows: [], sessions: [], measuredWaiting: [] }

/**
 * The native sessions as fleet entries, or none. Never throws: a failed read is an empty native
 * half, and the CLI fleet beside it is untouched — one source failing must not blank the other.
 */
export async function readNativeFleet(lang: 'pt' | 'en'): Promise<NativeFleet> {
  if (!(await nativeOn())) return NONE
  try {
    const [list, filings, notes] = await Promise.all([
      fetch(`${CREATE_URL}?limit=${NATIVE_LIST_LIMIT}`).then(r => (r.ok ? r.json() : null)) as Promise<{ sessions?: NativeListRecord[] } | null>,
      fetch('/api/tasks/native-filings').then(r => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ filings?: Record<string, NativeFilingFacts> } | null>,
      fetch('/api/fleet/native-notes').then(r => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ notes?: Record<string, string> } | null>,
    ])
    if (!list || !Array.isArray(list.sessions)) return NONE
    return nativeFleetEntries(list.sessions, filings?.filings ?? {}, lang, notes?.notes ?? {})
  } catch {
    return NONE
  }
}

/** A row verb for a native id, as the HTTP call the engine answers — or null for one it never takes. */
export function nativeVerbRequest(
  req: { id: string; action: string; text?: string },
): { url: string; method: 'PATCH' | 'POST'; body?: Record<string, string> } | null {
  const base = `${CREATE_URL}/${encodeURIComponent(req.id)}`
  switch (req.action) {
    // A note is the host's, not the engine's: the machine's own act keeps it beside the registry.
    case 'note': return { url: '/api/fleet/act', method: 'POST', body: { id: req.id, action: 'note', text: req.text ?? '' } }
    case 'rename': return { url: base, method: 'PATCH', body: { title: req.text ?? '' } }
    case 'kill': return { url: `${base}/end`, method: 'POST' }
    case 'resume': return { url: `${base}/reopen`, method: 'POST' }
    default: return null
  }
}

const NOT_HERE = {
  en: 'The native Agentistics runtime does not offer this yet.',
  pt: 'O runtime nativo do Agentistics ainda não oferece isto.',
} as const

/** Perform a row verb on a native session. The answer is the engine's own sentence when it refuses. */
export async function nativeAct(
  req: { id: string; action: string; text?: string },
  lang: 'pt' | 'en',
): Promise<{ ok: boolean; message: string; id?: string }> {
  const call = nativeVerbRequest(req)
  if (!call) return { ok: false, message: NOT_HERE[lang] }
  try {
    const res = await fetch(call.url, {
      method: call.method,
      ...(call.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(call.body) } : {}),
    })
    if (res.ok) return { ok: true, message: '' }
    const body = await res.json().catch(() => null)
    return { ok: false, message: refusalSentence(body, res.status, lang) }
  } catch {
    return { ok: false, message: lang === 'pt' ? 'Erro de rede ao falar com o runtime nativo.' : 'Network error talking to the native runtime.' }
  }
}
