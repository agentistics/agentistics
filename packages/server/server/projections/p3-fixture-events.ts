/**
 * projections/p3-fixture-events.ts — TEST SUPPORT. Real canonical event streams for the P3 projection
 * tests: the checked-in, redacted replay fixtures (`test/fixtures/claude-replay*`, `codex-replay`)
 * replayed by their own integrations, exactly as `agentop journal import` would. No IO beyond reading
 * those fixtures; nothing here touches `~/.agentistics`.
 *
 * Sources are sorted by id before replay and the result carries no dependence on directory listing
 * order (a test asserts it by loading twice).
 */
import { join } from 'node:path'
import type { AnyAgentisticsEvent } from '@agentistics/core'
import { createClaudeReplay } from '../integrations/claude'
import { createCodexReplay } from '../integrations/codex'
import type { HarnessReplay } from '../integrations/types'

export const FIXTURES = join(import.meta.dir, '../../test/fixtures')
const FAR = () => Date.parse('2100-01-01T00:00:00.000Z')

async function replayAll(r: HarnessReplay): Promise<AnyAgentisticsEvent[]> {
  const sources = (await r.discover()).sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
  const out: AnyAgentisticsEvent[] = []
  for (const s of sources) out.push(...((await r.replay(s, null)).events as AnyAgentisticsEvent[]))
  return out
}

/** Every event of the Claude + Codex replay fixtures, in a deterministic order. */
export async function fixtureEvents(): Promise<AnyAgentisticsEvent[]> {
  const out: AnyAgentisticsEvent[] = []
  for (const dir of ['claude-replay', 'claude-replay-compact', 'claude-replay-turn-end']) {
    out.push(...await replayAll(createClaudeReplay({ projectsDir: join(FIXTURES, dir), settledMs: 0, now: FAR })))
  }
  out.push(...await replayAll(createCodexReplay({ sessionsDir: join(FIXTURES, 'codex-replay/sessions'), settledMs: 0, now: FAR })))
  // The same conversation can appear in two fixture sets; the journal keeps one row per event id.
  const seen = new Set<string>()
  return out.filter(e => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
}

/** A deterministic shuffle — order independence must not depend on a lucky seed. */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Group events by a key function, dropping unkeyed ones. */
export function groupBy(events: readonly AnyAgentisticsEvent[], key: (e: AnyAgentisticsEvent) => string | null): Map<string, AnyAgentisticsEvent[]> {
  const m = new Map<string, AnyAgentisticsEvent[]>()
  for (const e of events) {
    const k = key(e)
    if (k === null) continue
    const g = m.get(k)
    if (g) g.push(e)
    else m.set(k, [e])
  }
  return m
}
