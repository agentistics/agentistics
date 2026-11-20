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
  /** Has an integrated installer; otherwise setup.docUrl provides official guidance. */
  canInstall?: boolean
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

/** PURE. Is there still something worth re-asking about: no answer yet, or an installed harness not signed in. */
export function chatHarnessesNeedPolling(harnesses: readonly HarnessChatStatus[]): boolean {
  return harnesses.length === 0 || harnesses.some(h => h.installed && !h.ready)
}

export const HARNESS_POLL_FAST_MS = 4000
export const HARNESS_POLL_SLOW_MS = 30_000
export const HARNESS_POLL_FAST_WINDOW_MS = 120_000
/** PURE. How long to wait before the next re-check: quick while a sign-in is likely being done, slow after. */
export function harnessPollDelay(sinceMs: number): number {
  return sinceMs < HARNESS_POLL_FAST_WINDOW_MS ? HARNESS_POLL_FAST_MS : HARNESS_POLL_SLOW_MS
}

/**
 * Fetches chat backends by default; all=true requests the complete session catalog,
 * including those that are not installed or not authenticated.
 */
export function useChatHarnesses(all = false): UseChatHarnessesResult {
  const [harnesses, setHarnesses] = useState<HarnessChatStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(all ? '/api/chat-harnesses?all=1' : '/api/chat-harnesses')
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
  }, [generation, all])

  // The badge must flip by itself after a sign-in, so re-check while an INSTALLED harness is not ready —
  // and stop the moment none is, so a settled machine pays nothing. A harness that is not installed does
  // not flip by itself (an install reloads explicitly), and with `all=1` there is always one: counting
  // it kept this poll alive for as long as the page was open, each round re-running the CLI probes.
  const settled = !chatHarnessesNeedPolling(harnesses)
  // `epoch` restarts the back-off clock: the tab becoming visible again and an explicit reload (the harness
  // picker opening, an install finishing) both mean "somebody is looking", so the quick cadence returns.
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    if (settled) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { timer = setTimeout(tick, harnessPollDelay(Date.now() - startedAt)) }
    const tick = () => { if (!document.hidden) setGeneration(n => n + 1); schedule() }
    const onVisible = () => {
      if (document.hidden) return
      clearTimeout(timer)
      setGeneration(n => n + 1)
      setEpoch(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    schedule()
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [settled, epoch])

  return { harnesses, loading, reload: () => { setGeneration(n => n + 1); setEpoch(n => n + 1) } }
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
  id: string, update = false, onProgress?: (line: string) => void, opts: { installNode?: boolean; lang?: 'pt' | 'en' } = {},
): Promise<InstallResult> {
  let response: Response
  try {
    response = await fetch(`/api/harnesses/${encodeURIComponent(id)}/${update ? 'update' : 'install'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, lang: opts.lang ?? 'pt', ...(opts.installNode ? { installNode: true } : {}) }),
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
  // The stream ended with neither `done` nor `error`: the CONNECTION dropped, not the installer —
  // which may well still be running. Saying "check your internet" here blamed the wrong thing.
  return {
    ok: false, code: 'failed',
    error: (opts.lang ?? 'pt') === 'pt'
      ? 'A conexão com o agentistics caiu durante a instalação, que pode ter continuado. Feche, aguarde um pouco e confira se o assistente aparece; se não, tente de novo (detalhes em ~/.agentistics/harness-install.log).'
      : 'The connection to agentistics dropped during the install, which may have kept going. Close, wait a moment and check whether the assistant shows up; if not, try again (details in ~/.agentistics/harness-install.log).',
  }
}

/** One harness's current status (fresh GET), or null when it is not listed (e.g. the native one) or the read fails. */
export async function fetchHarnessStatus(id: string): Promise<HarnessChatStatus | null> {
  try {
    const data = await (await fetch('/api/chat-harnesses')).json() as HarnessChatStatus[]
    return Array.isArray(data) ? data.find(h => h.id === id) ?? null : null
  } catch { return null }
}

/** Returns the ids of harnesses that are ready (installed + authed). */
export function getReadyHarnessIds(harnesses: HarnessChatStatus[]): string[] {
  return harnesses.filter(h => h.ready).map(h => h.id)
}
