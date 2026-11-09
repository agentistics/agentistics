import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// FLUXO.AVISOS 9 — the task tools must not freeze a vocabulary the board lets people edit, and creating a task must be able
// to say what the board orders by. A source-level check: the tool list is built inside the stdio server and is not exported.
const SRC = readFileSync(join(import.meta.dir, 'agentistics-mcp.ts'), 'utf8')
const block = (name: string) => {
  const start = SRC.indexOf(`name: "${name}"`)
  expect(start).toBeGreaterThan(-1)
  const next = SRC.indexOf('\n    name: "', start + 10)
  return SRC.slice(start, next === -1 ? undefined : next)
}

test('no tool schema hardcodes the retired status list (the board vocabulary is editable)', () => {
  expect(SRC).not.toContain('"backlog"')
  const subtask = block('agentistics_task_subtask')
  expect(subtask).toContain('agentistics_task_statuses')
  expect(subtask).not.toMatch(/enum: \["(?:todo|backlog)"/)
})

test('agentistics_task_create takes a priority and a type and forwards both', () => {
  const create = block('agentistics_task_create')
  expect(create).toContain('priority')
  expect(create).toContain('enum: ["urgent", "high", "medium", "low"]')
  expect(create).toContain('agentistics_task_types')
  const handler = SRC.slice(SRC.indexOf('case "agentistics_task_create"'), SRC.indexOf('case "agentistics_task_status"'))
  expect(handler).toContain('priority: a.priority')
  expect(handler).toContain('type: a.type')
})
