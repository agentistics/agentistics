/**
 * APP.LENTO — `readBilledReplies` resumes its journal walk from the last rowid instead of reading the
 * whole journal every 30 s. Real journal on a temp dir: whatever was appended, deleted or narrowed in
 * between, a resumed answer must equal the one a fresh walk gives.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANONICAL_EVENT_SCHEMA, deriveEventId, type AgentisticsEvent, type PlanLimits } from '@agentistics/core'
import { openJournal } from '../journal/journal'
import { readBilledReplies, resetBilledWalk } from './handoff-usage'
import type { AccountsFile } from '../harness-accounts'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-billed-walk-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const accounts: AccountsFile = { version: 2, accounts: [], bindings: {}, segments: {} } as unknown as AccountsFile
const HOUR = 3_600_000
const limitsAt = (now: number, weekResetIn = 24 * HOUR): PlanLimits[] => [{
  harness: 'claude', account: 'acc_x', windows: [{ kind: 'week', resetsAt: now + weekResetIn, usedPct: 10 }] as never, updatedAt: now, source: 'statusline' as never,
}]

function conversation(id: string, at: number, replies: number): AgentisticsEvent[] {
  const mk = (type: AgentisticsEvent['type'], ref: string, when: number, data: unknown): AgentisticsEvent => ({
    eventId: deriveEventId({ sourceKind: 'harness', sourceId: 'claude', sourceRef: `claude:${id}:${ref}`, type, ordinal: 0 }),
    schema: CANONICAL_EVENT_SCHEMA, type,
    occurredAt: new Date(when).toISOString(), recordedAt: new Date(when).toISOString(),
    sessionId: `ses_${id}`, runId: `run_${id}`,
    source: { kind: 'harness', id: 'claude', version: '1.0.0' },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.0.0', sourceRef: `claude:${id}:${ref}` },
    data: data as AgentisticsEvent['data'],
  })
  const out = [mk('run.started', 'open', at, { harness: 'claude', conversationId: id, conversationLink: 'observed' })]
  for (let i = 0; i < replies; i++) out.push(mk('model.completed', `msg:${i + 1}`, at + (i + 1) * 60_000, {
    provider: 'anthropic', model: 'claude-sonnet-5', status: 'completed', usage: { input: 100 + i, output: 20, cacheRead: 0, cacheWrite: 0 },
  }))
  return out
}

const fresh = async (path: string, limits: PlanLimits[]) => { resetBilledWalk(); return readBilledReplies(accounts, [], limits, path) }

describe('readBilledReplies — the resumed walk equals a fresh one', () => {
  test('appends, an old run whose response arrives later, a delete, and a narrower window', async () => {
    const path = join(root, 'journal.db')
    const now = Date.now()
    const j = await openJournal({ path })
    await j.append([...conversation('a', now - 3 * HOUR, 3), ...conversation('old', now - 30 * 24 * HOUR, 2)])
    const limits = limitsAt(now)
    resetBilledWalk()
    const first = await readBilledReplies(accounts, [], limits, path)
    expect(first.length).toBe(3)

    // New rows: a new conversation, and more responses for 'a' — read from the last rowid.
    await j.append([...conversation('b', now - 2 * HOUR, 2), ...conversation('a', now - 3 * HOUR, 5)])
    const resumed = await readBilledReplies(accounts, [], limits, path)
    expect(resumed).toEqual(await fresh(path, limits))
    expect(resumed.length).toBe(7)

    // A delete bumps the epoch: the walk starts over rather than keep what is gone.
    await readBilledReplies(accounts, [], limits, path)
    expect(await j.deleteBySourcePrefix!('claude:b')).toBeGreaterThan(0)
    const afterDelete = await readBilledReplies(accounts, [], limits, path)
    expect(afterDelete).toEqual(await fresh(path, limits))
    expect(afterDelete.some(r => r.conversationId === 'b')).toBe(false)

    // A narrower window drops what fell out; a wider one than the walk holds starts over.
    await readBilledReplies(accounts, [], limits, path)
    const narrow = limitsAt(now, 7 * 24 * HOUR - 2.5 * HOUR)
    const narrowed = await readBilledReplies(accounts, [], narrow, path)
    expect(narrowed).toEqual(await fresh(path, narrow))
    const wide = limitsAt(now, 0)
    const widened = await readBilledReplies(accounts, [], wide, path)
    expect(widened).toEqual(await fresh(path, wide))
    j.close()
  })
})
