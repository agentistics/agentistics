/** Characterization of the 1h/5m cache-write TTL breakdown `parseSessionJsonl` reads off
 *  `message.usage.cache_creation` — see `SessionMeta.cache_creation_1h_input_tokens`. */
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseSessionJsonl } from './jsonl'

function assistantTurn(id: string, ts: string, usage: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model: 'claude-opus-4-8', usage, content: [{ type: 'text', text: 'ok' }] },
  })
}

async function parse(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-jsonl-ttl-'))
  const file = join(dir, 's.jsonl')
  await writeFile(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-17T09:59:00.000Z', cwd: '/repo', message: { role: 'user', content: 'go' } }),
    ...lines,
  ].join('\n'))
  return parseSessionJsonl(file, 's', '/repo', 'jsonl')
}

test('reads the 1h/5m breakdown and their sum equals cache_creation_input_tokens', async () => {
  const s = await parse([
    assistantTurn('msg_1', '2026-09-17T10:00:00.000Z', {
      input_tokens: 2, output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 800_000, ephemeral_5m_input_tokens: 200_000 },
    }),
  ])
  expect(s.cache_creation_1h_input_tokens).toBe(800_000)
  expect(s.cache_creation_5m_input_tokens).toBe(200_000)
  expect((s.cache_creation_1h_input_tokens ?? 0) + (s.cache_creation_5m_input_tokens ?? 0))
    .toBe(s.cache_creation_input_tokens ?? 0)
})

test('a repeated message.id does not double-count either portion', async () => {
  // Claude Code writes the SAME message.usage on every content-block line of one turn — see
  // usage-dedupe.ts. Three lines, one billed response.
  const line = assistantTurn('msg_dup', '2026-09-17T10:01:00.000Z', {
    input_tokens: 2, output_tokens: 10,
    cache_creation_input_tokens: 500_000,
    cache_creation: { ephemeral_1h_input_tokens: 500_000, ephemeral_5m_input_tokens: 0 },
  })
  const s = await parse([line, line, line])
  expect(s.cache_creation_1h_input_tokens).toBe(500_000)
  expect(s.cache_creation_5m_input_tokens).toBe(0)
  expect(s.cache_creation_input_tokens).toBe(500_000)
})

test('sums the breakdown across several DISTINCT turns', async () => {
  const s = await parse([
    assistantTurn('msg_a', '2026-09-17T10:02:00.000Z', {
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 },
    }),
    assistantTurn('msg_b', '2026-09-17T10:03:00.000Z', {
      cache_creation_input_tokens: 50_000,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50_000 },
    }),
  ])
  expect(s.cache_creation_1h_input_tokens).toBe(100_000)
  expect(s.cache_creation_5m_input_tokens).toBe(50_000)
  expect(s.cache_creation_input_tokens).toBe(150_000)
})

test('a legacy record with no breakdown at all leaves both fields ABSENT, never a guessed 0/0', async () => {
  const s = await parse([
    assistantTurn('msg_legacy', '2026-09-17T10:04:00.000Z', {
      input_tokens: 2, output_tokens: 10,
      cache_creation_input_tokens: 300_000,
      // no `cache_creation` object — the pre-breakdown transcript shape.
    }),
  ])
  expect(s.cache_creation_input_tokens).toBe(300_000)
  expect(s.cache_creation_1h_input_tokens).toBeUndefined()
  expect(s.cache_creation_5m_input_tokens).toBeUndefined()
})

test('a partial breakdown (one turn has it, another does not) leaves both fields ABSENT rather than an under-counted split', async () => {
  const s = await parse([
    assistantTurn('msg_1', '2026-09-17T10:05:00.000Z', {
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 },
    }),
    assistantTurn('msg_2', '2026-09-17T10:06:00.000Z', {
      cache_creation_input_tokens: 50_000,
      // no breakdown on this turn, though it still contributes to the total.
    }),
  ])
  expect(s.cache_creation_input_tokens).toBe(150_000)
  expect(s.cache_creation_1h_input_tokens).toBeUndefined()
  expect(s.cache_creation_5m_input_tokens).toBeUndefined()
})
