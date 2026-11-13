import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TOOL_POLICY } from '../core/src/agentToolPolicy'
import { proofAudit } from './write-proof-audit'

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
 * The S0a allowlist is EMPTY since the S0d+S1c integration: every board writer proves itself, either explicitly
 * (`session: sessionProof(…)` / an audited builder) or through `apiSend`'s injection on `/api/tasks*` (`withTaskWriteProof`,
 * asserted below and driven end to end by `task-write-proof.test.ts`). It can never grow again: the baseline test pins it empty.
 */
const UNPROVEN_UNTIL_S0A = new Set<string>([])

/** The transport proof path is only trusted while `apiSend` really injects the pane's proof — checked over the source. */
const API_SEND_INJECTS = /async function apiSend\(method: string, path: string, body\?: unknown\) \{\s*const payload = withTaskWriteProof\(method, path, body, sessionProof\(process\.env\)\);[\s\S]{0,200}?body: JSON\.stringify\(payload\)/

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
      const proves = proofAudit(body, tool === 'agentistics_task_phase', { transportProvesTaskWrites: API_SEND_INJECTS.test(SRC) })
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

  test('F8 the S0a exception baseline is EMPTY and stays empty', () => {
    expect([...UNPROVEN_UNTIL_S0A]).toEqual([])
  })

  test('apiSend injects the pane proof into every task write (the transport proof path the audit trusts)', () => {
    expect(API_SEND_INJECTS.test(SRC)).toBe(true)
    // …and only one apiSend exists (a second, un-injecting copy cannot hide behind the name).
    expect(SRC.match(/async function apiSend\(/g)).toHaveLength(1)
  })

  test('the design exemption baseline remains empty', () => {
    expect(Object.keys(NO_PROOF_BY_DESIGN)).toEqual([])
  })
})
