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
    setLoading(true)
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
    const timer = window.setInterval(() => { if (!cancelled) setGeneration(n => n + 1) }, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [generation])

  return { harnesses, loading, reload: () => setGeneration(n => n + 1) }
}

export async function installHarness(id: string, update = false, onProgress?: (line: string) => void): Promise<{ ok: boolean; version?: string; error?: string }> {
  const response = await fetch(`/api/harnesses/${encodeURIComponent(id)}/${update ? 'update' : 'install'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
  })
  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => '')
    try {
      const detail = JSON.parse(raw) as { error?: string }
      const messages: Record<string, string> = {
        'node-required': 'Node.js é necessário para instalar este backend.',
        'unsupported-platform': 'Esta instalação funciona no Linux e no macOS.',
      }
      return { ok: false, error: messages[detail.error ?? ''] ?? detail.error ?? 'install_failed' }
    } catch { return { ok: false, error: raw || 'install_failed' } }
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const next = await reader.read()
    if (next.done) break
    buffer += next.value
    const records = buffer.split('\n\n')
    buffer = records.pop() ?? ''
    for (const record of records) {
      const line = record.split('\n').find(x => x.startsWith('data: '))
      if (!line) continue
      const event = JSON.parse(line.slice(6)) as { type: string; message?: string; version?: string }
      if (event.message) onProgress?.(event.message)
      if (event.type === 'done') return { ok: true, version: event.version }
      if (event.type === 'error') return { ok: false, error: event.message }
    }
  }
  return { ok: false, error: 'install_failed' }
}

/** Returns the ids of harnesses that are ready (installed + authed). */
export function getReadyHarnessIds(harnesses: HarnessChatStatus[]): string[] {
  return harnesses.filter(h => h.ready).map(h => h.id)
}
