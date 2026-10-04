/**
 * sessionTranscript.ts — PURE. Where a session's messages are read from, per harness.
 *
 * The "Details" popover used to fetch `/api/sessions/<id>/messages`, a route that has never existed
 * on this server. It 404s, the `.then(r => r.ok ? r.json() : [])` turns that into an empty array,
 * and the panel says "no recent messages" — on a live session with sixty-five of them. A confident
 * "there is nothing" produced by a request that was never answered is exactly the failure mode
 * `liveEmptyNotice` and `HARNESS_CAPABILITIES` exist to prevent, one layer up.
 *
 * The real readers were already there, one per harness, and they all return the same
 * `{ role, content, timestamp }` shape. This module is the mapping to them, as a
 * `Record<HarnessId, …>` so the build fails when a harness is added and nobody decides.
 */

import type { HarnessId, SessionMeta } from '@agentistics/core'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number | string
  tools?: string[]
}

/** Either where to read the transcript, or WHY it can never be read for this harness. */
export type TranscriptSource =
  | { kind: 'url'; url: string }
  | { kind: 'unavailable'; harness: HarnessId }

/**
 * Which harnesses this server can serve raw messages for.
 *
 * `false` is a FINDING, not a gap to be filled with an empty list: Antigravity and Kimi have no
 * message reader on this server, so the panel must say that rather than draw the same blank space a
 * session with nothing in it would draw.
 */
// @harness-adapters-only: transcript readers exist per adapter; a native session's chat is the engine's own.
const READABLE: Record<HarnessId, boolean> = {
  claude: true,
  codex: true,
  gemini: true,
  copilot: true,
  antigravity: false,
  kimi: false,
  // No legacy adapter (CLAUDE.md step 4, skipped by scope): opencode never produces a SessionMeta,
  // so there is no route for this server to serve its raw messages from in the first place.
  opencode: false,
}

/** The `~/.claude/projects` directory name for a path — the same encoding the server walks with. */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-')
}

export function transcriptSource(s: Pick<SessionMeta, 'session_id' | 'project_path' | 'harness'>): TranscriptSource {
  const harness = (s.harness ?? 'claude') as HarnessId
  if (!READABLE[harness]) return { kind: 'unavailable', harness }
  const id = encodeURIComponent(s.session_id)
  // Claude's reader is keyed by the PROJECT directory as well as the id — its transcripts live one
  // file per session under the encoded project folder, and the id alone does not locate one.
  if (harness === 'claude') {
    return {
      kind: 'url',
      url: `/api/claude-sessions/${id}?encodedDir=${encodeURIComponent(encodeProjectDir(s.project_path))}`,
    }
  }
  return { kind: 'url', url: `/api/${harness}-sessions/${id}` }
}

/** The sentence a panel prints instead of a blank list. Never "no messages" — that would be a claim. */
export function transcriptUnavailableNote(harness: HarnessId, lang: 'pt' | 'en'): string {
  return lang === 'pt'
    ? `Este build não lê o transcript do ${harness} — as mensagens desta sessão não são capturadas aqui.`
    : `This build has no message reader for ${harness} — this session's messages are not captured here.`
}
