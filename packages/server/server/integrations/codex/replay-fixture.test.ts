/**
 * The Codex replay over REAL rollout structure — `test/fixtures/codex-replay/sessions/`, four real
 * rollouts redacted to structural fields only (ids, timestamps, counters, tool names, model ids;
 * every prompt, answer, output and cwd replaced by a placeholder — master §42) plus one synthetic
 * rollout that exercises what this machine never wrote (a counter reset, an unstamped prompt, a
 * web_search_call, a bad JSON line, a blank line, a turn_aborted, a model switch).
 *
 * - GOLDEN: each rollout's event stream equals `expected/<nn>.events.json`, checked in and reviewed.
 * - CHUNK INDEPENDENCE (P1 §8): split at every line boundary (a non-final finish between chunks),
 *   the same events in the same order.
 * - COUNTER PARITY with `parseCodexRollout` over the same bytes: the per-turn deltas sum to its
 *   last-wins counters (except where the reset proves they must not), the last gauge is its
 *   `context_tokens`, tool.requested by canonical name is its `tool_counts`, turn.started is its
 *   `user_message_count`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { parseCodexRollout } from '../../adapters/codex-parse'
import { iterLines } from '../../jsonl'
import { collectRollouts, fallbackIdOf, rolloutIdOf } from './index'
import { CODEX_ADAPTER_VERSION, codexContext } from './replay-core'
import { emptyCodexReplay, finishCodexReplay, foldCodexReplay } from './replay'

const ROOT = join(import.meta.dir, '../../../test/fixtures/codex-replay')
const RECORDED_AT = '2026-09-27T00:00:00.000Z'
const FILES = await collectRollouts(join(ROOT, 'sessions'))

const essence = (e: AgentisticsEvent) => ({
  id: e.eventId, type: e.type, at: e.occurredAt, agent: e.agentId ?? null,
  ref: e.provenance.sourceRef, confidence: e.provenance.confidence, data: e.data,
})

function replayChunks(path: string, chunks: string[][]): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const s = emptyCodexReplay(codexContext(rolloutIdOf(path), fallbackIdOf(path), RECORDED_AT))
  for (const c of chunks) {
    foldCodexReplay(s, c, e => out.push(e))
    finishCodexReplay(s, { final: false }, e => out.push(e))
  }
  finishCodexReplay(s, { final: true }, e => out.push(e))
  return out
}

test('the fixture set is what it claims: five rollouts', () => {
  expect(FILES.length).toBe(5)
})

for (const path of FILES) {
  const id = rolloutIdOf(path)
  const text = readFileSync(path, 'utf-8')
  const lines = [...iterLines(text)]
  const whole = replayChunks(path, [lines])

  describe(`rollout …${id.slice(-2)}`, () => {
    test('golden: the event stream equals the reviewed expectation', () => {
      const expected = JSON.parse(readFileSync(join(ROOT, 'expected', `${id.slice(-2)}.events.json`), 'utf-8'))
      expect(whole.map(essence)).toEqual(expected)
    })

    test('chunk independence: split at EVERY line boundary, the same events', () => {
      const want = whole.map(essence)
      for (let i = 1; i < lines.length; i++) {
        expect(replayChunks(path, [lines.slice(0, i), lines.slice(i)]).map(essence)).toEqual(want)
      }
    })

    test('every envelope is complete and every id unique', () => {
      expect(new Set(whole.map(e => e.eventId)).size).toBe(whole.length)
      for (const e of whole) {
        expect(e.provenance.adapterVersion).toBe(CODEX_ADAPTER_VERSION)
        expect(e.provenance.mode).toBe('replayed')
        expect(['exact', 'estimated']).toContain(e.provenance.confidence)
        expect(e.provenance.sourceRef).toMatch(new RegExp(`^codex:${id}:\\d+$`))
        expect(e.source).toMatchObject({ kind: 'harness', id: 'codex' })
      }
    })

    test('counter parity with parseCodexRollout over the same bytes', () => {
      const legacy = parseCodexRollout(text, fallbackIdOf(path))!
      const mc = whole.filter(e => e.type === 'model.completed') as AgentisticsEvent<'model.completed'>[]
      const sum = mc.reduce((a, e) => ({
        input: a.input + (e.data.usage.input ?? 0), cacheRead: a.cacheRead + (e.data.usage.cacheRead ?? 0),
        output: a.output + (e.data.usage.output ?? 0),
      }), { input: 0, cacheRead: 0, output: 0 })
      if (id.endsWith('05')) {
        // The synthetic reset: legacy keeps only the post-reset snapshot; the replay adds both series.
        expect({ input: legacy.input_tokens, cacheRead: legacy.cache_read_input_tokens, output: legacy.output_tokens })
          .toEqual({ input: 300, cacheRead: 100, output: 10 })
        expect(sum).toEqual({ input: 1500, cacheRead: 400, output: 90 })
      } else {
        expect(sum).toEqual({ input: legacy.input_tokens ?? 0, cacheRead: legacy.cache_read_input_tokens ?? 0, output: legacy.output_tokens ?? 0 })
      }
      expect(mc.at(-1)?.data.contextTokens).toBe(legacy.context_tokens)
      const tools: Record<string, number> = {}
      for (const e of whole) if (e.type === 'tool.requested') {
        const n = (e as AgentisticsEvent<'tool.requested'>).data.canonicalName
        tools[n] = (tools[n] ?? 0) + 1
      }
      expect(tools).toEqual(legacy.tool_counts)
      expect(whole.filter(e => e.type === 'turn.started').length).toBe(legacy.user_message_count)
    })
  })
}
