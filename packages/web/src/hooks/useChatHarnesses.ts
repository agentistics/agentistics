import { useState, useEffect } from 'react'

// NOTE: The types below (ChatDriverSetup, ChatDriverModel, HarnessChatStatus) mirror
// packages/server/server/chat-drivers/types.ts, which is the source of truth.
// They are redeclared here because the web layer cannot import server-side modules
// (Vite would attempt to bundle them and fail on Node/Bun APIs). Keep in sync manually.

/** Static guidance for install / login shown when a harness is not ready. */
export interface ChatDriverSetup {
  /** Shell command to install the CLI (e.g. 'npm i -g @openai/codex'). */
  installCmd?: string
  /** Shell command to authenticate (e.g. 'codex login'). */
  loginCmd?: string
  /** URL to official docs or the product page. */
  docUrl?: string
  /** Extra human-readable note (e.g. eligibility caveat). */
  note?: string
}

export interface ChatDriverModel {
  id: string
  label: string
  badge?: string
  desc?: string
  inputPer1M?: number
  outputPer1M?: number
}

/** Per-harness status entry returned by GET /api/chat-harnesses. */
export interface HarnessChatStatus {
  id: string
  label: string
  /** CLI binary is found on PATH. */
  installed: boolean
  /** Auth/config file is present (best-effort). */
  authReady: boolean
  /** installed && authReady — driver is usable. */
  ready: boolean
  version?: string
  updateAvailable?: boolean
  /** From the server's ONE model catalog — the CLI's own list where it publishes one. */
  models: ChatDriverModel[]
  /** `cli`: the harness's own list. `table`: the incomplete fallback. Absent on an older server. */
  modelsSource?: 'cli' | 'table'
  /** The picker must also accept a typed id (the list is the table, which cannot name them all). */
  modelFreeText?: boolean
  /** The machine's configured default, or `''` — the CLI's own, with no `--model` at all. */
  defaultModel: string
  setup: ChatDriverSetup
}

export interface UseChatHarnessesResult {
  harnesses: HarnessChatStatus[]
  loading: boolean
  reload: () => void
}

/**
 * Fetches GET /api/chat-harnesses and returns status for ALL known harnesses,
 * including those that are not installed or not authenticated.
 */
export function useChatHarnesses(): UseChatHarnessesResult {
  const [harnesses, setHarnesses] = useState<HarnessChatStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/chat-harnesses')
      .then(r => r.json() as Promise<HarnessChatStatus[]>)
      .then(data => {
        if (!cancelled) {
          setHarnesses(Array.isArray(data) ? data : [])
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [generation])

  // The badge must flip by itself after an install or a sign-in, so re-check while anything is not
  // ready — and stop the moment everything is, so a settled machine pays nothing.
  const settled = harnesses.length > 0 && harnesses.every(h => h.ready)
  useEffect(() => {
    if (settled) return
    const timer = window.setInterval(() => setGeneration(n => n + 1), 4000)
    return () => window.clearInterval(timer)
  }, [settled])

  return { harnesses, loading, reload: () => setGeneration(n => n + 1) }
}

export interface InstallResult {
  ok: boolean
  version?: string
  /** A plain sentence for the person, or the code `node-required` / `unsupported-platform` / `busy`. */
  error?: string
  code?: 'node-required' | 'unsupported-platform' | 'busy' | 'failed'
}

/** Runs the official installer on the server and streams its progress lines. Never call this
 *  without the person having confirmed — the server refuses a body without `confirmed`. */
export async function installHarness(
  id: string, update = false, onProgress?: (line: string) => void, opts: { installNode?: boolean } = {},
): Promise<InstallResult> {
  let response: Response
  try {
    response = await fetch(`/api/harnesses/${encodeURIComponent(id)}/${update ? 'update' : 'install'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, ...(opts.installNode ? { installNode: true } : {}) }),
    })
  } catch { return { ok: false, code: 'failed' } }
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({})) as { error?: string }
    if (detail.error === 'node-required') return { ok: false, code: 'node-required' }
    if (detail.error === 'unsupported-platform') return { ok: false, code: 'unsupported-platform' }
    if (response.status === 409) return { ok: false, code: 'busy' }
    return { ok: false, code: 'failed' }
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const next = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (next.done) break
    buffer += next.value
    const records = buffer.split('\n\n')
    buffer = records.pop() ?? ''
    for (const record of records) {
      const line = record.split('\n').find(x => x.startsWith('data: '))
      if (!line) continue
      let event: { type: string; message?: string; version?: string }
      try { event = JSON.parse(line.slice(6)) } catch { continue }
      if (event.type === 'done') return { ok: true, ...(event.version ? { version: event.version } : {}) }
      if (event.type === 'error') return { ok: false, code: 'failed', ...(event.message ? { error: event.message } : {}) }
      if (event.message) onProgress?.(event.message)
    }
  }
  return { ok: false, code: 'failed' }
}

/** "Entrar": starts the harness (its own login prompt) in an ordinary session; resolves to its id. */
export async function loginHarness(id: string, lang: 'pt' | 'en'): Promise<{ ok: boolean; id?: string; message: string }> {
  try {
    const res = await fetch(`/api/fleet/harness-login?lang=${lang}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: id }),
    })
    const json = await res.json() as { ok: boolean; id?: string; message?: string }
    return { ok: json.ok === true, ...(json.id ? { id: json.id } : {}), message: json.message ?? '' }
  } catch {
    return { ok: false, message: lang === 'pt' ? 'Não consegui falar com esta máquina.' : 'Could not reach this machine.' }
  }
}

/** Returns the ids of harnesses that are ready (installed + authed). */
export function getReadyHarnessIds(harnesses: HarnessChatStatus[]): string[] {
  return harnesses.filter(h => h.ready).map(h => h.id)
}
