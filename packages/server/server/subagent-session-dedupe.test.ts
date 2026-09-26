/**
 * One billed response counts ONCE per SESSION — across the main transcript and every subagent file.
 *
 * The shapes are the real ones measured on 2026-09-25/26 (docs/superpowers/research/
 * 2026-09-25-p1-parity-differential.md §3.4 and §7): a conversation fork (`meta.isFork: true`)
 * opens with a `fork-context-ref` line and then the parent's LAUNCHING response under its original
 * `message.id`, and a background fork that no parent's content names is reachable only through its
 * own `meta.parentAgentId`. Structural fields only: synthetic ids, types, counters, timestamps.
 */
import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionAgentMetrics } from '@agentistics/core'
import { enrichFromSubagentTranscripts } from './subagent-metrics'
import { claimSessionUsage, summarizeSubagentTranscript } from './subagent-parse'
import { planSubtrees, type AgentEntry } from './subagent-join'

const MODEL = 'claude-sonnet-5'

async function machine(
  sessionId: string,
  files: Record<string, string[]>,
  metas: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'agentistics-subagent-dedupe-'))
  const dir = join(root, sessionId, 'subagents')
  await mkdir(dir, { recursive: true })
  for (const [agentId, lines] of Object.entries(files)) {
    await writeFile(join(dir, `agent-${agentId}.jsonl`), lines.join('\n') + '\n')
  }
  for (const [agentId, meta] of Object.entries(metas)) {
    await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta))
  }
  return { transcriptPath: join(root, `${sessionId}.jsonl`) }
}

/** One assistant usage line, as Claude Code writes it: the four counters under `message.usage`. */
function resp(id: string, u: { i?: number; o?: number; cr?: number; cw?: number }, at = '2026-09-01T10:00:00.000Z') {
  return JSON.stringify({
    type: 'assistant', timestamp: at,
    message: {
      id, model: MODEL, content: [],
      usage: { input_tokens: u.i ?? 0, output_tokens: u.o ?? 0, cache_read_input_tokens: u.cr ?? 0, cache_creation_input_tokens: u.cw ?? 0 },
    },
  })
}

/** Line 1 of every fork transcript. */
function forkRef(agentId: string) {
  return JSON.stringify({ type: 'fork-context-ref', agentId, contextLength: 42, parentLastUuid: 'u-parent', parentSessionId: 's' })
}

function unmeasured(toolUseId: string, agentId: string): SessionAgentMetrics['invocations'][number] {
  return {
    toolUseId, agentId, unmeasured: true, agentType: 'fork', description: 'd',
    status: 'completed', totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
    costUSD: 0,
  }
}

function metrics(...invocations: SessionAgentMetrics['invocations']): SessionAgentMetrics {
  return { invocations, totalInvocations: invocations.length, unmeasuredInvocations: invocations.length, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 }
}

// ── the main transcript's responses are already counted there ──────────────────────────────────

test('a fork that REPLAYS the main transcript’s launching response does not count it again', async () => {
  // The fork opens with the parent turn that launched it, under its ORIGINAL message.id. The main
  // transcript's totals already carry that response; the invocation must carry only its own work.
  const { transcriptPath } = await machine('s-fork',
    { aFork: [forkRef('aFork'), resp('msg_launch', { i: 2, cr: 75_000, cw: 3_000, o: 3 }), resp('msg_own', { o: 10, cr: 90 })] },
    { aFork: { agentType: 'fork', isFork: true, toolUseId: 'toolu_1', spawnDepth: 1 } },
  )

  const out = await enrichFromSubagentTranscripts(
    metrics(unmeasured('toolu_1', 'aFork')), transcriptPath, 's-fork', new Set(['msg_launch']))

  expect(out.invocations[0]!.totalTokens).toBe(100)
  expect(out.totalTokens).toBe(100)
})

test('a fork carrying an EARLIER partial snapshot of a main response does not count it either', async () => {
  // 813e0cce: six forks launched from ONE streamed parent response; five carry the earlier snapshot
  // (78,678) of a response the main transcript settles at 83,409. The main copy is the one counted,
  // because it is main — the fork's partial copy contributes nothing.
  const { transcriptPath } = await machine('s-partial',
    { aFork: [forkRef('aFork'), resp('msg_launch', { cr: 78_000, o: 1 }), resp('msg_own', { o: 7 })] },
    { aFork: { agentType: 'fork', isFork: true, toolUseId: 'toolu_1', spawnDepth: 1 } },
  )

  const out = await enrichFromSubagentTranscripts(
    metrics(unmeasured('toolu_1', 'aFork')), transcriptPath, 's-partial', new Set(['msg_launch']))

  expect(out.invocations[0]!.totalTokens).toBe(7)
})

// ── across subagent files ──────────────────────────────────────────────────────────────────────

test('two nested forks replaying their parent’s response count it ONCE, as the parent’s copy', async () => {
  const { transcriptPath } = await machine('s-siblings',
    {
      aRoot: [resp('msg_p', { cr: 1_000, o: 50 }), resp('msg_p', { cr: 1_000, o: 60 })],
      aF1: [forkRef('aF1'), resp('msg_p', { cr: 1_000, o: 20 }), resp('msg_f1', { o: 5 })],
      aF2: [forkRef('aF2'), resp('msg_p', { cr: 1_000, o: 40 }), resp('msg_f2', { o: 3 })],
    },
    {
      aRoot: { toolUseId: 'toolu_1', spawnDepth: 1 },
      aF1: { isFork: true, parentAgentId: 'aRoot', spawnDepth: 2 },
      aF2: { isFork: true, parentAgentId: 'aRoot', spawnDepth: 2 },
    },
  )

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aRoot')), transcriptPath, 's-siblings')

  // The root's own LAST line (1_060) + each fork's own response. Never the forks' partial copies.
  expect(out.invocations[0]!.totalTokens).toBe(1_060 + 5 + 3)
  expect(out.invocations).toHaveLength(1)
})

test('two top-level forks sharing a response count it once across the session', async () => {
  // A response neither in main nor owned by an ancestor: the tie between equals is settled by the
  // agentId, so the session total is right whatever order the directory lists them in.
  const { transcriptPath } = await machine('s-twins',
    {
      aB: [forkRef('aB'), resp('msg_shared', { o: 100 }), resp('msg_b', { o: 1 })],
      aA: [forkRef('aA'), resp('msg_shared', { o: 100 }), resp('msg_a', { o: 2 })],
    },
    {
      aA: { isFork: true, toolUseId: 'toolu_a', spawnDepth: 1 },
      aB: { isFork: true, toolUseId: 'toolu_b', spawnDepth: 1 },
    },
  )

  const out = await enrichFromSubagentTranscripts(
    metrics(unmeasured('toolu_b', 'aB'), unmeasured('toolu_a', 'aA')), transcriptPath, 's-twins')

  expect(out.totalTokens).toBe(100 + 1 + 2)
  expect(out.invocations.find(i => i.agentId === 'aA')!.totalTokens).toBe(102)
  expect(out.invocations.find(i => i.agentId === 'aB')!.totalTokens).toBe(1)
})

test('a response written several times in ONE subagent file counts its LAST line', async () => {
  const s = summarizeSubagentTranscript([
    resp('msg_x', { o: 1, cr: 10 }),
    resp('msg_x', { o: 30, cr: 10 }),
  ])
  expect(s.usage).toEqual([{ model: MODEL, inputTokens: 0, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0 }])
})

// ── nesting by meta.parentAgentId ──────────────────────────────────────────────────────────────

test('a background fork NO parent content names is found through its own meta.parentAgentId', async () => {
  const { transcriptPath } = await machine('s-unnamed',
    {
      aRoot: [resp('msg_r', { o: 10 })],
      aBg: [forkRef('aBg'), resp('msg_bg', { o: 900 })],
      aBgChild: [resp('msg_bgc', { o: 90 })],
    },
    {
      aRoot: { toolUseId: 'toolu_1', spawnDepth: 1 },
      aBg: { isFork: true, parentAgentId: 'aRoot', spawnDepth: 2 },
      aBgChild: { parentAgentId: 'aBg', spawnDepth: 3 },
    },
  )

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aRoot')), transcriptPath, 's-unnamed')

  expect(out.invocations).toHaveLength(1)
  expect(out.invocations[0]!.totalTokens).toBe(10 + 900 + 90)
})

test('a nested transcript reachable from two roots is counted under ONE of them, never both', async () => {
  const { transcriptPath } = await machine('s-shared-child',
    {
      aA: [resp('msg_a', { o: 1 }), JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aKid' } })],
      aB: [resp('msg_b', { o: 2 })],
      aKid: [resp('msg_k', { o: 1000 })],
    },
    {
      aA: { toolUseId: 'toolu_a', spawnDepth: 1 },
      aB: { toolUseId: 'toolu_b', spawnDepth: 1 },
      aKid: { parentAgentId: 'aB', spawnDepth: 2 },
    },
  )

  const out = await enrichFromSubagentTranscripts(
    metrics(unmeasured('toolu_a', 'aA'), unmeasured('toolu_b', 'aB')), transcriptPath, 's-shared-child')

  expect(out.totalTokens).toBe(1 + 2 + 1000)
})

// ── order independence (the pure halves) ───────────────────────────────────────────────────────

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
}

test('ownership does not depend on the order the files are listed in', () => {
  const root = summarizeSubagentTranscript([resp('msg_p', { o: 60 }), resp('msg_r', { o: 1 })])
  const f1 = summarizeSubagentTranscript([forkRef('f1'), resp('msg_p', { o: 20 }), resp('msg_main', { o: 999 }), resp('msg_s', { o: 7 })])
  const f2 = summarizeSubagentTranscript([forkRef('f2'), resp('msg_p', { o: 40 }), resp('msg_s', { o: 9 })])
  const members = [
    { agentId: 'aRoot', depth: 0, summary: root },
    { agentId: 'aF2', depth: 1, summary: f2 },
    { agentId: 'aF1', depth: 1, summary: f1 },
  ]
  const answers = permutations(members).map(p => {
    const owned = claimSessionUsage(new Set(['msg_main']), p)
    return JSON.stringify([...owned.entries()].sort(([a], [b]) => a.localeCompare(b)))
  })
  expect(new Set(answers).size).toBe(1)

  const owned = claimSessionUsage(new Set(['msg_main']), members)
  expect(owned.get('aRoot')![0]!.outputTokens).toBe(61)
  // msg_s: depth tie between the two forks, the smaller agentId owns it — with ITS copy (7).
  expect(owned.get('aF1')![0]!.outputTokens).toBe(7)
  expect(owned.get('aF2') ?? []).toEqual([])
})

test('the subtree plan does not depend on the order the directory lists the entries in', () => {
  const entries: AgentEntry[] = [
    { agentId: 'aA', meta: { toolUseId: 'toolu_a', spawnDepth: 1 } },
    { agentId: 'aB', meta: { toolUseId: 'toolu_b', spawnDepth: 1 } },
    { agentId: 'aKid', meta: { parentAgentId: 'aB', spawnDepth: 2 } },
    { agentId: 'aGrand', meta: { parentAgentId: 'aKid', isFork: true, spawnDepth: 3 } },
    { agentId: 'aOrphan', meta: { isFork: true, spawnDepth: 1 } },
  ]
  const named = new Map<string, string[]>([['aA', ['aKid']]])
  const answers = permutations(entries).map(p => JSON.stringify([...planSubtrees(['aA', 'aB'], p, named).entries()]))
  expect(new Set(answers).size).toBe(1)

  const plan = planSubtrees(['aA', 'aB'], entries, named)
  // Roots in the PARENT's order: aA reaches aKid first (named in its content), and aGrand hangs off it.
  expect(plan.get('aA')).toEqual([{ agentId: 'aA', depth: 0 }, { agentId: 'aKid', depth: 1 }, { agentId: 'aGrand', depth: 2 }])
  expect(plan.get('aB')).toEqual([{ agentId: 'aB', depth: 0 }])
})

test('subagents that name each other cannot loop forever, by either route', () => {
  const entries: AgentEntry[] = [
    { agentId: 'aA', meta: { toolUseId: 'toolu_a', parentAgentId: 'aB' } },
    { agentId: 'aB', meta: { parentAgentId: 'aA' } },
  ]
  const plan = planSubtrees(['aA'], entries, new Map([['aB', ['aA']]]))
  expect(plan.get('aA')).toEqual([{ agentId: 'aA', depth: 0 }, { agentId: 'aB', depth: 1 }])
})

// ── the main transcript's ids reach the subagent pass, on every path that enriches ─────────────

import { openParseCache } from './parse-cache'
import { cachedEnrich, cachedParseSession } from './parse-cache-jsonl'
import { parseSessionJsonl } from './jsonl'
import { resetTranscriptStates } from './transcript-state'

async function sessionOnDisk(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), 'agentistics-main-ids-'))
  const file = join(root, `${sessionId}.jsonl`)
  // The launching turn: an `Agent` tool_use the parent never answered (a background fork), and
  // the response that carries it — the one the fork opens with.
  const launch = JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/w', sessionId,
    message: {
      id: 'msg_launch', model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'd', subagent_type: 'fork' } }],
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 75_000, cache_creation_input_tokens: 3_000 },
    },
  })
  await writeFile(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-01T09:59:59.000Z', cwd: '/w', sessionId, message: { role: 'user', content: 'go' } }),
    launch,
  ].join('\n') + '\n')
  const dir = join(root, sessionId, 'subagents')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent-aFork.jsonl'),
    [forkRef('aFork'), resp('msg_launch', { i: 2, o: 3, cr: 75_000, cw: 3_000 }), resp('msg_own', { o: 10, cr: 90 }, '2026-09-01T10:00:20.000Z')].join('\n') + '\n')
  await writeFile(join(dir, 'agent-aFork.meta.json'), JSON.stringify({ agentType: 'fork', isFork: true, toolUseId: 'toolu_1', spawnDepth: 1 }))
  return { root, file }
}

test('parseSessionJsonl: the fork’s replay of the launching response is not counted twice', async () => {
  const { file } = await sessionOnDisk('s-parse')
  const meta = await parseSessionJsonl(file, 's-parse', '/w', 'jsonl')
  expect(meta.agentMetrics?.totalTokens).toBe(100)
})

test('cachedEnrich: the MISS and the memo HIT both exclude the main transcript’s ids', async () => {
  const { root, file } = await sessionOnDisk('s-enrich')
  const cache = await openParseCache(join(root, 'cache.db'))
  const miss = await cachedEnrich(cache, file, '')
  expect(miss?.agentMetrics?.totalTokens).toBe(100)

  // A hit must not need the parent's walk (it may have been evicted) — the ids travel in the row.
  resetTranscriptStates()
  const hit = await cachedEnrich(cache, file, '')
  expect(cache.stats().hits).toBeGreaterThan(0)
  expect(hit?.agentMetrics?.totalTokens).toBe(100)
  cache.close()
})

test('cachedParseSession: the same answer through the session memo', async () => {
  const { root, file } = await sessionOnDisk('s-cached')
  const cache = await openParseCache(join(root, 'cache.db'))
  const meta = await cachedParseSession(cache, file, 's-cached', '/w', 'jsonl')
  expect(meta.agentMetrics?.totalTokens).toBe(100)
  cache.close()
})
