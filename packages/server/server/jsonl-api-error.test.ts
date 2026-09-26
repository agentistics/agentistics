/** Characterization of `isApiErrorMessage` handling in `parseSessionJsonl` — see the addendum
 *  "One billed response is counted ONCE" in CLAUDE.md, dated 2026-09-26.
 *
 *  Claude Code writes a SYNTHETIC assistant line when an API call could not be completed:
 *  `isApiErrorMessage: true`, `message.model: '<synthetic>'`, and a `message.usage` whose four
 *  counters and nested `cache_creation` object are all zero. Measured structurally on four real
 *  sessions (2b6a45f5, 32d4f58b, 626e097d, b6ad99a8) whose ONLY usage-bearing line was exactly this
 *  record — every one reported `cache_creation_1h_input_tokens: 0` / `..._5m_input_tokens: 0` as an
 *  OBSERVED split, when nothing was ever billed. The canonical replay
 *  (`integrations/claude/replay-model.ts` on origin/fix/parity-residuals) emits nothing for this
 *  line — no `model.invoked`/`model.completed`, only a separate `model.failed` — and legacy must
 *  agree: no usage, no TTL-split observation, no model, no context gauge, no daily-bucket
 *  contribution.
 */
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

/** The exact structural shape measured on the four real sessions — synthetic model, all-zero
 *  usage, the TTL-split object present but zeroed, `error` a plain string. */
function apiErrorTurn(id: string, ts: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    isApiErrorMessage: true,
    error: 'model_not_found',
    message: {
      id,
      model: '<synthetic>',
      content: [{ type: 'text', text: 'error text' }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      },
    },
  })
}

async function parse(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-jsonl-api-error-'))
  const file = join(dir, 's.jsonl')
  await writeFile(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-26T09:59:00.000Z', cwd: '/repo', message: { role: 'user', content: 'go' } }),
    ...lines,
  ].join('\n'))
  return parseSessionJsonl(file, 's', '/repo', 'jsonl')
}

test('a session whose ONLY usage line is an API-error line reports no tokens, no model, and an ABSENT TTL split', async () => {
  const s = await parse([
    apiErrorTurn('err_1', '2026-09-26T10:00:00.000Z'),
  ])
  expect(s.input_tokens).toBe(0)
  expect(s.output_tokens).toBe(0)
  expect(s.cache_read_input_tokens).toBe(0)
  expect(s.cache_creation_input_tokens).toBe(0)
  // The defect: these used to read `0` (an OBSERVED zero split) instead of being absent.
  expect(s.cache_creation_1h_input_tokens).toBeUndefined()
  expect(s.cache_creation_5m_input_tokens).toBeUndefined()
  expect(s.model).toBeUndefined()
  expect(s.context_tokens).toBeUndefined()
})

test('a real response plus an API-error line: the real one counts, the error adds nothing', async () => {
  const s = await parse([
    assistantTurn('msg_real', '2026-09-26T10:01:00.000Z', {
      input_tokens: 2, output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 800_000, ephemeral_5m_input_tokens: 200_000 },
    }),
    apiErrorTurn('err_2', '2026-09-26T10:02:00.000Z'),
  ])
  expect(s.input_tokens).toBe(2)
  expect(s.output_tokens).toBe(10)
  expect(s.cache_creation_input_tokens).toBe(1_000_000)
  expect(s.cache_creation_1h_input_tokens).toBe(800_000)
  expect(s.cache_creation_5m_input_tokens).toBe(200_000)
  expect(s.model).toBe('claude-opus-4-8')
})

test('an API-error line arriving BEFORE the real response still leaves the real one as the only contributor', async () => {
  const s = await parse([
    apiErrorTurn('err_3', '2026-09-26T10:03:00.000Z'),
    assistantTurn('msg_real2', '2026-09-26T10:04:00.000Z', {
      input_tokens: 5, output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 400_000,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 400_000 },
    }),
  ])
  expect(s.input_tokens).toBe(5)
  expect(s.output_tokens).toBe(20)
  expect(s.cache_creation_1h_input_tokens).toBe(0)
  expect(s.cache_creation_5m_input_tokens).toBe(400_000)
  expect(s.model).toBe('claude-opus-4-8')
})
