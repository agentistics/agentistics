/**
 * useAppData — one AppData snapshot kept fresh by the server's SSE stream.
 *
 * The old TUI ran its own chokidar watcher plus a user-configured repaint interval. The server
 * already pushes on `/api/events` (the same stream the browser dashboard listens to), so the
 * terminal now updates at the same instant the web UI does, and the interval question is gone.
 *
 * A poll is kept ONLY as the fallback for a server too old to serve the stream, or a stream that
 * cannot be established — never as the primary path.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppData } from '@agentistics/core'

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'offline'

const POLL_FALLBACK_MS = 10_000

export interface AppDataResult {
  data: AppData | null
  error: string | null
  connection: ConnectionState
  refresh: () => void
}

export interface AppDataOptions {
  /**
   * Read at all.
   *
   * `false` closes the stream and stops the poll while keeping whatever was last read, which is what
   * makes this usable from a TAB: the control center keeps every screen mounted (`display: none`),
   * so a dashboard that fetched regardless would hold an SSE connection open and re-read the whole
   * payload every few seconds while nobody was looking at it — battery and network spent in silence.
   * The stale snapshot is kept deliberately: coming back to the tab redraws instantly and refetches
   * behind it, rather than flashing a loading state at a reader who was here ten seconds ago.
   */
  enabled?: boolean
  /**
   * Bumped to force a re-read — the shell's `r` key, arriving from outside this hook.
   *
   * A nonce rather than an exposed imperative call because `refresh` is recreated on every render,
   * so a caller wiring it into an effect would re-fetch on every keystroke instead of on the key
   * that asked for it.
   */
  nonce?: number
}

/** `apiBase` is nullable: there is no address to read from until the host says the server is up. */
export function useAppData(apiBase: string | null, opts: AppDataOptions = {}): AppDataResult {
  const { enabled = true, nonce = 0 } = opts
  const [data, setData] = useState<AppData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const alive = useRef(true)

  /**
   * RES.1 — ONE `/api/data` read in flight, plus at most one queued behind it. The payload is ~5 MB
   * and every SSE event asked for a fresh copy, so a burst of events stacked several full reads and
   * parses in memory at once. Events that land while a read is running collapse into one re-read.
   */
  const inFlight = useRef(false)
  const again = useRef(false)

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (!apiBase) return
    if (inFlight.current) { again.current = true; return }
    inFlight.current = true
    try {
      await fetchNow()
    } finally {
      inFlight.current = false
    }
    if (again.current && alive.current) {
      again.current = false
      void fetchOnce()
    }
  }, [apiBase])

  const fetchNow = async () => {
    if (!apiBase) return
    try {
      const res = await fetch(`${apiBase}/api/data`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as AppData
      if (!alive.current) return
      setData(json)
      setError(null)
    } catch (e) {
      if (!alive.current) return
      setError(e instanceof Error ? e.message : String(e))
      setConnection('offline')
    }
  }

  useEffect(() => {
    alive.current = true
    if (enabled && apiBase) void fetchOnce()
    return () => { alive.current = false }
  }, [fetchOnce, enabled, apiBase, nonce])

  // SSE subscription, with a poll fallback if the stream never opens.
  useEffect(() => {
    if (!enabled || !apiBase) return
    let poll: ReturnType<typeof setInterval> | undefined
    const controller = new AbortController()

    const startPolling = () => {
      if (poll) return
      setConnection(prev => (prev === 'offline' ? prev : 'polling'))
      poll = setInterval(() => { void fetchOnce() }, POLL_FALLBACK_MS)
    }

    const run = async () => {
      try {
        const res = await fetch(`${apiBase}/api/events`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        setConnection('live')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (alive.current) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // Any event at all means the dataset moved; refetch the snapshot.
          if (buffer.includes('\n\n')) {
            buffer = ''
            void fetchOnce()
          }
        }
        if (alive.current) startPolling()
      } catch {
        if (alive.current) startPolling()
      }
    }

    void run()
    return () => {
      controller.abort()
      if (poll) clearInterval(poll)
    }
  }, [apiBase, fetchOnce, enabled])

  return { data, error, connection, refresh: () => { void fetchOnce() } }
}
