/**
 * PURE: the uploader's STOP after a 401/403 from a central.
 *
 * 2026-10-03: a member logged `ingest returned 403; stopping push` every 2–5 s for hours. The line
 * was true of ONE push; the next file change (push-on-change fires on every transcript write)
 * started another full ingest, which was refused again. The durable `authFailedAt` mark only lands
 * after a 10-minute sustain window, so for those ten minutes — and on every connection object that
 * did not carry the mark yet — nothing stopped anything.
 *
 * Now the first 401/403 STOPS the connection in memory, keyed by a fingerprint of what the central
 * judged (endpoint + token): no further ingest, no further log line. It is lifted by
 *  - a change of that configuration (`cleared` — a new token, a new endpoint), or
 *  - a cheap `whoami` probe, at most once per `AUTH_STOP_PROBE_MS`, that the central no longer
 *    rejects — a central that was only restarting recovers by itself, which is the case the
 *    sustain window exists for (team-uploader.ts, AUTH_FAIL_SUSTAIN_MS).
 */
import { createHash } from 'crypto'

export const AUTH_STOP_PROBE_MS = 60_000

export interface AuthStop {
  fingerprint: string
  /** When the central was last asked (the stop itself counts as asking). */
  probedAtMs: number
}

/** sha256 of endpoint + token: compares configurations without holding the token. */
export function authStopFingerprint(endpoint: string, token: string | undefined): string {
  return createHash('sha256').update(`${endpoint.replace(/\/+$/, '')}\0${token ?? ''}`).digest('hex')
}

export function authStopGate(stop: AuthStop | undefined, fingerprint: string, nowMs: number): 'push' | 'skip' | 'probe' | 'cleared' {
  if (!stop) return 'push'
  if (stop.fingerprint !== fingerprint) return 'cleared'
  return nowMs - stop.probedAtMs >= AUTH_STOP_PROBE_MS ? 'probe' : 'skip'
}
