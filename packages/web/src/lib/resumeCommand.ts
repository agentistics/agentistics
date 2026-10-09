import type { SurfaceHarnessId, SessionMeta } from '@agentistics/core'

/** How each CLI resumes a session by id, verified against each tool's own `--help`:
 *   claude  → `claude --resume <uuid>`
 *   agy     → `agy --conversation <id>`      ("Resume a previous conversation by ID")
 *   codex   → `codex resume <SESSION_ID>`    (positional; UUIDs take precedence)
 *   copilot → `copilot --resume <id>`        ("optionally specify existing session ID")
 *   kimi    → `kimi -S <id>`                 ("Resume a session. With ID: resume that session")
 *
 *   gemini  → `gemini --resume <uuid>`       (documented as "latest | index"; the CLI's own refusal text
 *                                              lists `--resume {uuid}` and it was verified on 0.63.0 — an index
 *                                              would reopen a neighbour once another session is born)
 *
 * Gemini's id is the chat header's UUID (`native_session_id`), not the store key. A gemini session
 * recorded without one has NO command: emitting a plausible-looking one that does the wrong thing
 * is worse than saying it is unavailable. */
const RESUME_BY_HARNESS: Partial<Record<SurfaceHarnessId, (id: string) => string>> = {
  claude: id => `claude --resume ${id}`,
  antigravity: id => `agy --conversation ${id}`,
  codex: id => `codex resume ${id}`,
  copilot: id => `copilot --resume ${id}`,
  kimi: id => `kimi -S ${id}`,
  // Gemini's store key is the synthetic `<project>/<file>`; the CLI takes the chat header's UUID.
  gemini: id => `gemini --resume ${id}`,
}

/** Copy-ready shell command to resume a session, or null when the harness has no way to do it. */
export function resumeCommand(s: SessionMeta): string | null {
  const build = RESUME_BY_HARNESS[s.harness]
  // A harness whose store key is not the id its CLI takes names it in `native_session_id`; a
  // session of such a harness without one (gemini, written before the header was read) has no
  // command rather than a wrong one.
  const id = s.harness === 'gemini' ? s.native_session_id : s.session_id
  if (!build || !id) return null
  const resume = build(id)
  return s.project_path ? `cd '${s.project_path}' && ${resume}` : resume
}
