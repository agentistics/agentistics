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
}

/**
 * Fetches GET /api/chat-harnesses and returns status for ALL known harnesses,
 * including those that are not installed or not authenticated.
 */
export function useChatHarnesses(): UseChatHarnessesResult {
  const [harnesses, setHarnesses] = useState<HarnessChatStatus[]>([])
  const [loading, setLoading] = useState(true)

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
    return () => { cancelled = true }
  }, [])

  return { harnesses, loading }
}

/** Returns the ids of harnesses that are ready (installed + authed). */
export function getReadyHarnessIds(harnesses: HarnessChatStatus[]): string[] {
  return harnesses.filter(h => h.ready).map(h => h.id)
}
