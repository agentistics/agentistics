/**
 * data-slim.ts — the FIRST-SCREEN payload (`/api/data?partial=1&slim=1`).
 *
 * `/api/data` is 5 MB on a real machine and most of it is per-session detail the first screen never
 * draws: `message_hours` alone is 2,4 MB (a lifetime array of hours), `agentMetrics` 0,9 MB,
 * `user_message_timestamps` 0,3 MB. A phone on mobile data through a relay stayed on the loading screen
 * waiting for all of it. The slim answer keeps what every page's chrome and the home KPIs read — the
 * stats cache, the projects, the harness list and the most recent sessions WITHOUT those arrays — and
 * says so (`partial: true`, `partialReason: 'slim'`), so the app paints it and asks for the full
 * payload straight after. It is a PREFIX of the truth, never a different truth: nothing in it is
 * computed, only left out.
 */
import type { ApiResponse } from './data'

/** Fields that are large per session and are drawn only once a session is opened or charted. */
export const SLIM_DROPPED_SESSION_FIELDS = [
  'message_hours',
  'user_message_timestamps',
  'agentMetrics',
  'tool_output_tokens',
  'user_response_times',
  'tool_error_categories',
] as const

/** How many sessions the slim answer carries (most recent first). */
export const SLIM_SESSION_LIMIT = 200

export function slimApiResponse(data: ApiResponse): ApiResponse {
  const drop = new Set<string>(SLIM_DROPPED_SESSION_FIELDS)
  const recent = [...data.sessions]
    .sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''))
    .slice(0, SLIM_SESSION_LIMIT)
    .map(s => Object.fromEntries(Object.entries(s).filter(([k]) => !drop.has(k))) as typeof s)
  return {
    ...data,
    sessions: recent,
    // Workflows carry per-run timelines; the full payload brings them.
    workflows: [],
    partial: true,
    partialReason: 'slim',
  }
}

const SLIM_SERIALIZED = new WeakMap<ApiResponse, string>()

/** The slim answer as JSON, built once per source build (same reason `serializedData` is). */
export function slimSerialized(data: ApiResponse): string {
  let s = SLIM_SERIALIZED.get(data)
  if (s === undefined) { s = JSON.stringify(slimApiResponse(data)); SLIM_SERIALIZED.set(data, s) }
  return s
}
