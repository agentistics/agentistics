import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TOOL_POLICY } from '../core/src/agentToolPolicy'

/**
 * S1c (Codex QA gap): every MCP tool that WRITES to the board or the delivery book must carry the calling session's proof —
 * otherwise the server reads "no proof" as the owner. The check is per tool, over the handler's own source, so removing
 * `sessionProof` from ONE tool fails here even when the shared helpers are intact.
 *
 * The exceptions are decisions, each with its reason; a new write tool is covered by default.
 */
const SRC = readFileSync(join(import.meta.dir, 'agentistics-mcp.ts'), 'utf8')

/** Tools that write to /api/tasks, /api/task-files or /api/deliveries, from the policy table (not from a hand list). */
const WRITERS = Object.entries(AGENT_TOOL_POLICY)
  .filter(([, p]) => p.routes.some(r => !r.startsWith('GET ') && /\/api\/(tasks|task-files|deliveries)\b/.test(r)))
  .map(([name]) => name)

/** tool → why it deliberately sends no session proof. */
const NO_PROOF_BY_DESIGN: Record<string, string> = {}

/**
 * SHRINKING allowlist: board-writing tools that, in THIS base, still send no proof. S0a ("proof on every MCP task write",
 * spec §8) delivers it; when it lands each of these must be DELETED from the list — the second test below fails for a tool
 * that has gained its proof but is still listed, so the list can only shrink, and a tool NOT listed can never lose its proof.
 */
const UNPROVEN_UNTIL_S0A = new Set([
  'agentistics_task_create', 'agentistics_task_status', 'agentistics_task_status_edit', 'agentistics_task_type_edit', 'agentistics_task_subtask',
  'agentistics_task_link', 'agentistics_task_blocked_by', 'agentistics_task_claim', 'agentistics_task_edit', 'agentistics_task_session', 'agentistics_task_delete',
])

function handlerOf(tool: string): string {
  const start = SRC.indexOf(`case "${tool}":`)
  if (start === -1) return ''
  const rest = SRC.slice(start + 1)
  const next = rest.search(/\n\s*case "agentistics_/)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('every MCP write tool proves which session it runs in', () => {
  test('the policy table lists the board/delivery writers (so this test is not vacuous)', () => {
    expect(WRITERS.length).toBeGreaterThan(8)
    for (const t of ['agentistics_task_evidence', 'agentistics_task_phase', 'agentistics_task_stage', 'agentistics_task_comment']) expect(WRITERS).toContain(t)
  })

  for (const tool of WRITERS) {
    test(`${tool} sends the session proof`, () => {
      if (NO_PROOF_BY_DESIGN[tool]) return
      const body = handlerOf(tool)
      expect(body.length, `handler for ${tool} not found`).toBeGreaterThan(0)
      const proves = /sessionProof\(/.test(body)
      if (UNPROVEN_UNTIL_S0A.has(tool)) {
        // listed = known gap; it must really still be one (so a delivered proof forces the entry out)
        expect(proves, `${tool} now sends the proof: delete it from UNPROVEN_UNTIL_S0A`).toBe(false)
        return
      }
      expect(proves, `${tool} handler never calls sessionProof`).toBe(true)
    })
  }

  test('every allowlisted tool is a real writer (a typo cannot hide a tool)', () => {
    for (const t of UNPROVEN_UNTIL_S0A) expect(WRITERS, t).toContain(t)
  })

  test('the exemption list is empty or explained (no silent holes)', () => {
    for (const [tool, why] of Object.entries(NO_PROOF_BY_DESIGN)) { expect(WRITERS).toContain(tool); expect(why.length).toBeGreaterThan(20) }
  })
})
