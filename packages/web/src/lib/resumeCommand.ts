import type { SurfaceHarnessId, SessionMeta } from '@agentistics/core'

/** How each CLI resumes a session by id, verified against each tool's own `--help`:
 *   claude  → `claude --resume <uuid>`
 *   agy     → `agy --conversation <id>`      ("Resume a previous conversation by ID")
 *   codex   → `codex resume <SESSION_ID>`    (positional; UUIDs take precedence)
 *   copilot → `copilot --resume <id>`        ("optionally specify existing session ID")
 *   kimi    → `kimi -S <id>`                 ("Resume a session. With ID: resume that session")
 *
 * Gemini is deliberately absent: its `--resume` takes "latest" or a list index, not a session id
 * (`--session-id` starts a NEW session with that id), so there is no command that reopens a
 * specific past session. Emitting a plausible-looking command that does the wrong thing is worse
 * than saying it is unavailable. */
const RESUME_BY_HARNESS: Partial<Record<SurfaceHarnessId, (id: string) => string>> = {
  claude: id => `claude --resume ${id}`,
  antigravity: id => `agy --conversation ${id}`,
  codex: id => `codex resume ${id}`,
  copilot: id => `copilot --resume ${id}`,
  kimi: id => `kimi -S ${id}`,
}

/** Copy-ready shell command to resume a session, or null when the harness has no way to do it. */
export function resumeCommand(s: SessionMeta): string | null {
  const build = RESUME_BY_HARNESS[s.harness]
  if (!build || !s.session_id) return null
  const resume = build(s.session_id)
  return s.project_path ? `cd '${s.project_path}' && ${resume}` : resume
}
