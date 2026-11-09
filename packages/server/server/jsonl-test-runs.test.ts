/** The Live's "running the tests" step reads `SessionMeta.test_runs`, counted from Claude's Bash tool calls. */
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseSessionJsonl } from './jsonl'
import { sessionActivityOf } from './sessions/task-live-steps'

function bash(command: string, id = 'tu_1'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-04T10:00:00.000Z',
    message: {
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  })
}

async function parse(lines: string[], source: 'jsonl' | 'subdir' = 'jsonl') {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-jsonl-'))
  const file = join(dir, 's.jsonl')
  await writeFile(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-08-04T09:59:00.000Z', cwd: '/repo', message: { role: 'user', content: 'go' } }),
    ...lines,
  ].join('\n'))
  return parseSessionJsonl(file, 's', '/repo', source)
}

test('counts test-runner commands from Bash tool calls, wrappers and chains included', async () => {
  const s = await parse([
    bash('NODE_OPTIONS=--max-old-space-size=3500 agentop run --rm -- bun test packages/web', 'a'),
    bash('bunx tsc --noEmit && bun test', 'b'),
    bash('git commit -m "bun test"', 'c'),
  ])
  expect(s.test_runs).toBe(2)
  expect(s.git_commits).toBe(1)
})

test('a transcript that ran no tests answers a real 0, and the Live reads it as "read, no tests"', async () => {
  const s = await parse([bash('ls')])
  expect(s.test_runs).toBe(0)
  expect(sessionActivityOf(s)!.tests).toBe(0)
})

test('a record that was never read for tests says null, not zero', () => {
  expect(sessionActivityOf({ tool_counts: { Edit: 1 }, git_commits: 0 })!.tests).toBeNull()
})
