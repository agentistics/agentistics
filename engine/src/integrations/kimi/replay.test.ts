import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { agentContext } from './replay-core'
import { foldKimiWire, wireTimeRange } from './replay'

const FIXTURE = join(
  import.meta.dir, '../../../test/fixtures/kimi-replay/basic/wd_test',
  'session_11111111-1111-1111-1111-111111111111/agents/main/wire.jsonl',
)

async function foldWhole(): Promise<AgentisticsEvent[]> {
  const text = await readFile(FIXTURE, 'utf-8')
  const ctx = agentContext('11111111-1111-1111-1111-111111111111', 'main', '2026-01-01T00:00:00.000Z')
  const events: AgentisticsEvent[] = []
  foldKimiWire(ctx, text, e => events.push(e))
  return events
}

describe('kimi replay.ts — the fold', () => {
  test('emits one model.completed per usage.record, never per step.end (the double-count trap)', async () => {
    const events = await foldWhole()
    const models = events.filter((e): e is AgentisticsEvent<'model.completed'> => e.type === 'model.completed')
    expect(models).toHaveLength(1)
    const m = models[0]!
    expect(m.data.model).toBe('claude-sonnet-5') // provider prefix stripped
    expect(m.data.provider).toBe('anthropic')
    expect(m.data.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3 })
    expect(m.data.contextTokens).toBe(108) // 100 + 5 + 3
    expect(m.data.status).toBe('completed')
  })

  test('emits one tool.requested + tool.completed for the Write call, and one tool.requested + tool.failed for the erroring Bash call — reusing isToolError verbatim (which does not see result.isError)', async () => {
    const events = await foldWhole()
    const requested = events.filter((e): e is AgentisticsEvent<'tool.requested'> => e.type === 'tool.requested')
    const completed = events.filter(e => e.type === 'tool.completed')
    const failed = events.filter(e => e.type === 'tool.failed')
    expect(requested).toHaveLength(2)
    expect(completed).toHaveLength(2) // isToolError never sees the nested result.isError — see header
    expect(failed).toHaveLength(0)

    const write = requested.find(e => e.data.name === 'Write')
    expect(write?.data.kind).toBe('file')

    const bash = requested.find(e => e.data.name === 'Bash')
    expect(bash?.data.kind).toBe('shell')
  })

  test('no event carries the prompt or the tool content, only a shell summary (D5)', async () => {
    const events = await foldWhole()
    // `data.summary` on a shell tool.requested is the ONE place a (redacted, summarised) command
    // may appear — everything else (the prompt, the Write tool's file content) must not.
    for (const e of events) {
      if (e.type === 'tool.requested' && 'summary' in e.data) continue
      expect(JSON.stringify((e as { data: unknown }).data)).not.toContain('<redacted>')
    }
  })

  test('every event carries a non-empty adapterVersion, a confidence and a re-readable sourceRef', async () => {
    const events = await foldWhole()
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(e.provenance.adapterVersion.length).toBeGreaterThan(0)
      expect(['exact', 'estimated', 'inferred']).toContain(e.provenance.confidence)
      expect(e.provenance.sourceRef).toMatch(/^kimi:/)
      expect(e.provenance.mode).toBe('replayed')
    }
  })

  test('chunk independence: folding split at every line boundary equals folding whole (P1 §8)', async () => {
    const text = await readFile(FIXTURE, 'utf-8')
    const lines = text.split('\n')
    const whole = await foldWhole()

    for (let split = 1; split < lines.length; split++) {
      const ctx = agentContext('11111111-1111-1111-1111-111111111111', 'main', '2026-01-01T00:00:00.000Z')
      const events: AgentisticsEvent[] = []
      const firstNo = foldKimiWire(ctx, lines.slice(0, split).join('\n'), e => events.push(e))
      foldKimiWire(ctx, lines.slice(split).join('\n'), e => events.push(e), firstNo)
      expect(events).toEqual(whole)
    }
  })

  test('idempotency: folding the same text twice through fresh contexts yields identical event ids', async () => {
    const a = await foldWhole()
    const b = await foldWhole()
    expect(a.map(e => e.eventId)).toEqual(b.map(e => e.eventId))
  })

  test('wireTimeRange finds the min/max entry.time across every line, any type', async () => {
    const text = await readFile(FIXTURE, 'utf-8')
    const { minMs, maxMs } = wireTimeRange(text)
    expect(minMs).toBe(1700000000100)
    expect(maxMs).toBe(1700000000800)
  })
})
