import { describe, test, expect } from 'bun:test'
import { calcCost, getModelPrice, sessionModelUsage, sessionCostUSD, MODEL_PRICING, formatModel, getModelColor, formatProjectName, projectFolder, HARNESS_CAPABILITIES, emptyStatsCache, mergeStatsCaches, sanitizeStatsCache, normalizeGitRemote, repoShortName, canonicalProjectPath, HARNESS_ORDER, sessionDay, normalizeSessionTimes } from './types'
import type { ModelUsage, StatsCache } from './types'

describe('sanitizeStatsCache', () => {
  function sc(over: Partial<StatsCache>): StatsCache {
    return { ...emptyStatsCache(), ...over }
  }

  test('drops dailyActivity entries with a missing date', () => {
    const input = sc({
      dailyActivity: [
        { date: '2026-01-01', messageCount: 5, sessionCount: 2, toolCallCount: 3 },
        { date: undefined as unknown as string, messageCount: 9, sessionCount: 1, toolCallCount: 0 },
      ],
    })
    const out = sanitizeStatsCache(input)
    expect(out.dailyActivity).toEqual([{ date: '2026-01-01', messageCount: 5, sessionCount: 2, toolCallCount: 3 }])
  })

  test('drops dailyActivity entries with a non-string or empty date', () => {
    const input = sc({
      dailyActivity: [
        { date: '2026-01-01', messageCount: 1, sessionCount: 1, toolCallCount: 1 },
        { date: null as unknown as string, messageCount: 2, sessionCount: 1, toolCallCount: 0 },
        { date: '', messageCount: 3, sessionCount: 1, toolCallCount: 0 },
        { date: 12345 as unknown as string, messageCount: 4, sessionCount: 1, toolCallCount: 0 },
      ],
    })
    const out = sanitizeStatsCache(input)
    expect(out.dailyActivity).toHaveLength(1)
    expect(out.dailyActivity[0]!.date).toBe('2026-01-01')
  })

  test('drops dailyModelTokens entries with a missing date', () => {
    const input = sc({
      dailyModelTokens: [
        { date: '2026-01-01', tokensByModel: { 'claude-x': 100 } },
        { date: undefined as unknown as string, tokensByModel: { 'claude-x': 50 } },
      ],
    })
    const out = sanitizeStatsCache(input)
    expect(out.dailyModelTokens).toEqual([{ date: '2026-01-01', tokensByModel: { 'claude-x': 100 } }])
  })

  test('tolerates a statsCache with no dailyActivity/dailyModelTokens at all', () => {
    const input = { version: 1 } as StatsCache
    expect(() => sanitizeStatsCache(input)).not.toThrow()
    expect(sanitizeStatsCache(input).dailyActivity).toEqual([])
  })

  test('leaves a well-formed statsCache untouched', () => {
    const input = sc({
      dailyActivity: [{ date: '2026-01-01', messageCount: 5, sessionCount: 2, toolCallCount: 3 }],
      dailyModelTokens: [{ date: '2026-01-01', tokensByModel: { 'claude-x': 100 } }],
    })
    const out = sanitizeStatsCache(input)
    expect(out.dailyActivity).toHaveLength(1)
    expect(out.dailyModelTokens).toHaveLength(1)
  })
})

describe('mergeStatsCaches', () => {
  function sc(over: Partial<StatsCache>): StatsCache {
    return { ...emptyStatsCache(), ...over }
  }

  test('empty input returns an empty statsCache', () => {
    const m = mergeStatsCaches([])
    expect(m.totalSessions).toBe(0)
    expect(m.dailyActivity).toEqual([])
  })

  test('sums totals, daily activity, model usage, and hour counts', () => {
    const a = sc({
      totalSessions: 10, totalMessages: 100,
      dailyActivity: [{ date: '2026-01-01', messageCount: 5, sessionCount: 2, toolCallCount: 3 }],
      modelUsage: { 'claude-x': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.5 } },
      hourCounts: { '9': 4 },
      firstSessionDate: '2026-01-01', lastComputedDate: '2026-01-10',
    })
    const b = sc({
      totalSessions: 5, totalMessages: 50,
      dailyActivity: [{ date: '2026-01-01', messageCount: 1, sessionCount: 1, toolCallCount: 1 }, { date: '2026-01-02', messageCount: 9, sessionCount: 3, toolCallCount: 0 }],
      modelUsage: { 'claude-x': { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 2.5 } },
      hourCounts: { '9': 1, '10': 2 },
      firstSessionDate: '2025-12-20', lastComputedDate: '2026-01-05',
    })
    const m = mergeStatsCaches([a, b])
    expect(m.totalSessions).toBe(15)
    expect(m.totalMessages).toBe(150)
    // same-date daily activity summed
    expect(m.dailyActivity.find(d => d.date === '2026-01-01')).toEqual({ date: '2026-01-01', messageCount: 6, sessionCount: 3, toolCallCount: 4 })
    expect(m.dailyActivity).toHaveLength(2)
    // model usage summed
    expect(m.modelUsage['claude-x']!.inputTokens).toBe(4)
    expect(m.modelUsage['claude-x']!.costUSD).toBeCloseTo(4)
    // hour counts summed
    expect(m.hourCounts['9']).toBe(5)
    expect(m.hourCounts['10']).toBe(2)
    // earliest first / latest last
    expect(m.firstSessionDate).toBe('2025-12-20')
    expect(m.lastComputedDate).toBe('2026-01-10')
  })
})

// Helpers

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    ...overrides,
  }
}

// getModelPrice

describe('getModelPrice', () => {
  test('retorna preço exato para modelo conhecido', () => {
    expect(getModelPrice('claude-sonnet-4-6')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.30,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
    })
  })

  test('retorna preço exato para opus', () => {
    expect(getModelPrice('claude-opus-4-6')).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.50,
      cacheWrite: 6.25,
      cacheWrite1h: 10,
    })
  })

  test('retorna preço exato para haiku', () => {
    const price = getModelPrice('claude-haiku-4-5-20251001')
    expect(price.input).toBe(1)
    expect(price.output).toBe(5)
  })

  test('fallback para sonnet quando modelo desconhecido', () => {
    expect(getModelPrice('modelo-inexistente')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
    })
  })

  test('match parcial por prefixo — modelId começa com chave conhecida', () => {
    const price = getModelPrice('claude-opus-4-6-custom-suffix')
    expect(price.input).toBe(5)
  })
})

// calcCost

describe('calcCost', () => {
  test('zero tokens → custo zero', () => {
    expect(calcCost(usage(), 'claude-sonnet-4-6')).toBe(0)
  })

  test('1M input tokens de sonnet → $3', () => {
    const cost = calcCost(usage({ inputTokens: 1_000_000 }), 'claude-sonnet-4-6')
    expect(cost).toBe(3)
  })

  test('1M output tokens de sonnet → $15', () => {
    const cost = calcCost(usage({ outputTokens: 1_000_000 }), 'claude-sonnet-4-6')
    expect(cost).toBe(15)
  })

  test('1M input + 1M output de sonnet → $18', () => {
    const cost = calcCost(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), 'claude-sonnet-4-6')
    expect(cost).toBe(18)
  })

  test('cache read tokens aplicam preço correto', () => {
    // 1M cache read de sonnet → $0.30
    const cost = calcCost(usage({ cacheReadInputTokens: 1_000_000 }), 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(0.30)
  })

  test('cache write tokens aplicam preço correto', () => {
    // 1M cache write de sonnet → $3.75
    const cost = calcCost(usage({ cacheCreationInputTokens: 1_000_000 }), 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(3.75)
  })

  test('opus custa mais que haiku para mesmo volume de tokens', () => {
    const u = usage({ inputTokens: 100_000, outputTokens: 100_000 })
    expect(calcCost(u, 'claude-opus-4-6')).toBeGreaterThan(calcCost(u, 'claude-haiku-4-5-20251001'))
  })

  test('modelo desconhecido usa preço de fallback (sonnet)', () => {
    const u = usage({ inputTokens: 1_000_000 })
    expect(calcCost(u, 'modelo-desconhecido')).toBe(calcCost(u, 'claude-sonnet-4-6'))
  })

  test('custo proporcional — dobrar tokens dobra custo', () => {
    const base = calcCost(usage({ inputTokens: 500_000 }), 'claude-opus-4-6')
    const double = calcCost(usage({ inputTokens: 1_000_000 }), 'claude-opus-4-6')
    expect(double).toBeCloseTo(base * 2)
  })
})

// calcCost — 1h vs 5m cache-write TTL (Anthropic bills a 1-hour-TTL cache write at 2x base
// input and a 5-minute-TTL one at 1.25x; see MODEL_PRICING's `cacheWrite1h`).

describe('calcCost — cache-write TTL breakdown', () => {
  test('1h-only cache write is priced at 2x input, not the 1.25x 5-minute rate', () => {
    // claude-sonnet-4-6: input $3/M → cacheWrite1h $6/M (2x), cacheWrite (5m) $3.75/M (1.25x).
    const cost = calcCost(usage({
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheCreation5mInputTokens: 0,
    }), 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(6)
  })

  test('5m-only cache write, stated explicitly, prices the same as the plain 1.25x rate', () => {
    const cost = calcCost(usage({
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 0,
      cacheCreation5mInputTokens: 1_000_000,
    }), 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(3.75)
  })

  test('a mix of 1h and 5m cache writes sums each portion at its own rate', () => {
    // claude-opus-4-8: cacheWrite1h $10/M, cacheWrite (5m) $6.25/M.
    const cost = calcCost(usage({
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 800_000,
      cacheCreation5mInputTokens: 200_000,
    }), 'claude-opus-4-8')
    // 800k * $10/M + 200k * $6.25/M = 8 + 1.25
    expect(cost).toBeCloseTo(9.25)
  })

  test('the legacy shape — no TTL breakdown at all — keeps pricing the whole counter at the 5-minute rate, unchanged', () => {
    const cost = calcCost(usage({ cacheCreationInputTokens: 1_000_000 }), 'claude-opus-4-8')
    expect(cost).toBeCloseTo(6.25)
  })

  test('a session priced before vs after the fix: the exact understatement on a fixture', () => {
    const beforeFix = calcCost(usage({ cacheCreationInputTokens: 1_000_000 }), 'claude-opus-4-8')
    const afterFix = calcCost(usage({
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 800_000,
      cacheCreation5mInputTokens: 200_000,
    }), 'claude-opus-4-8')
    expect(beforeFix).toBeCloseTo(6.25)
    expect(afterFix).toBeCloseTo(9.25)
    expect(afterFix - beforeFix).toBeCloseTo(3) // understated by $3 on this 1M-token fixture
  })

  test('a HALF-present breakdown (one TTL field set, the other genuinely undefined) is treated as NO breakdown — never a partial one that drops the unstated remainder', () => {
    // claude-opus-4-8: cacheWrite1h $10/M, cacheWrite (5m) $6.25/M. Only 30k of the session's
    // 100k cache-write tokens are stated as 1h; the other 70k have no stated TTL at all — a `||`
    // gate would price the stated 30k at $10/M (=$0.30) and silently drop the other 70k at NO
    // rate, which is the exact under-reporting direction this feature exists to fix.
    const cost = calcCost(usage({
      cacheCreationInputTokens: 100_000,
      cacheCreation1hInputTokens: 30_000,
      // cacheCreation5mInputTokens intentionally left undefined — a half-present breakdown.
    }), 'claude-opus-4-8')
    // Falls back to the conservative "no breakdown" reading: the WHOLE counter at the 5m rate.
    expect(cost).toBeCloseTo(0.625)
    expect(cost).not.toBeCloseTo(0.30)
  })
})

// formatModel

describe('formatModel', () => {
  test('retorna nome legível para modelos conhecidos', () => {
    expect(formatModel('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(formatModel('claude-opus-4-6')).toBe('Opus 4.6')
    expect(formatModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  test('retorna o próprio ID para modelos não mapeados', () => {
    expect(formatModel('claude-qualquer-coisa')).toBe('claude-qualquer-coisa')
  })
})

// getModelColor

describe('getModelColor', () => {
  test('opus tem cor âmbar', () => {
    expect(getModelColor('claude-opus-4-6')).toBe('#D97706')
  })

  test('sonnet tem cor índigo', () => {
    expect(getModelColor('claude-sonnet-4-6')).toBe('#6366f1')
  })

  test('haiku tem cor verde', () => {
    expect(getModelColor('claude-haiku-4-5-20251001')).toBe('#10b981')
  })

  test('modelo desconhecido tem cor padrão', () => {
    expect(getModelColor('outro-modelo')).toBe('#8b5cf6')
  })
})

// formatProjectName

describe('formatProjectName', () => {
  test('retorna "Unknown" para string vazia', () => {
    expect(formatProjectName('')).toBe('Unknown')
  })

  // The home directory is NEVER abbreviated: on a central the same `~/app` would be three
  // different people's folders, and `~` would resolve against the central's own home rather than
  // the machine the session came from. The username is part of the path's identity.
  test('keeps the full path even inside the home directory', () => {
    expect(formatProjectName('/home/user/projetos/app')).toBe('/home/user/projetos/app')
  })

  test('the home directory itself is shown in full', () => {
    expect(formatProjectName('/home/user')).toBe('/home/user')
  })

  test('windows separators are normalized without abbreviating', () => {
    expect(formatProjectName('C:\\Users\\bryan\\app')).toBe('C:/Users/bryan/app')
  })

  test('caminho fora do home retorna caminho completo', () => {
    expect(formatProjectName('/opt/apps/servidor')).toBe('/opt/apps/servidor')
  })
})

describe('projectFolder', () => {
  test('keeps only the folder name', () => {
    expect(projectFolder('/home/mithrandir/agentistics')).toBe('agentistics')
    expect(projectFolder('C:\\Users\\bryan\\app')).toBe('app')
  })

  test('a trailing slash does not yield an empty name', () => {
    expect(projectFolder('/home/user/app/')).toBe('app')
  })

  test('a name with no separator is returned as is, and an empty path stays Unknown', () => {
    expect(projectFolder('app')).toBe('app')
    expect(projectFolder('')).toBe('Unknown')
  })
})

// OpenAI/Codex pricing

test('gpt-5.5 resolves to a non-fallback price', () => {
  const price = getModelPrice('gpt-5.5')
  // Must differ from the Sonnet 4.6 fallback ($3 in / $15 out)
  expect(price.input === 3 && price.output === 15).toBe(false)
})

test('calcCost works for a codex usage record', () => {
  const cost = calcCost(
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
    'gpt-5.5',
  )
  expect(cost).toBeGreaterThan(0)
})

test('formatModel renders gpt-5.5 readably', () => {
  expect(formatModel('gpt-5.5')).toBe('GPT-5.5')
})

// Google/Gemini pricing

test('gemini-3-flash-preview resolves to a non-fallback price', () => {
  const price = getModelPrice('gemini-3-flash-preview')
  // Must NOT fall back to the Sonnet 4.6 rates ($3 in / $15 out)
  expect(price.input === 3 && price.output === 15).toBe(false)
  expect(price.input).toBe(0.5)
  expect(price.output).toBe(3)
  expect(price.cacheRead).toBe(0.05)
})

test('formatModel renders gemini-3-flash-preview as "Gemini 3 Flash"', () => {
  expect(formatModel('gemini-3-flash-preview')).toBe('Gemini 3 Flash')
})

test('getModelColor returns Google blue for gemini models', () => {
  expect(getModelColor('gemini-3-flash-preview')).toBe('#4285f4')
  expect(getModelColor('gemini-2.5-flash')).toBe('#4285f4')
})

test('gemini-2.5-flash resolves to correct price', () => {
  const price = getModelPrice('gemini-2.5-flash')
  expect(price.input).toBe(0.3)
  expect(price.output).toBe(2.5)
})

// HARNESS_CAPABILITIES

test('HARNESS_CAPABILITIES declares every harness', () => {
  expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'gemini', 'kimi'])
})

test('kimi reports tokens, model and cost', () => {
  expect(HARNESS_CAPABILITIES.kimi.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.kimi.model).toBe(true)
  expect(HARNESS_CAPABILITIES.kimi.cost).toBe(true)
})

test('a model Kimi routed to is priced from its own provider, not a default', () => {
  // Kimi stamps `google/gemini-3.5-flash-lite`; the adapter strips the prefix so this resolves.
  const price = getModelPrice('gemini-3.5-flash-lite')
  expect(price.input).toBe(0.3)
  expect(price.output).toBe(2.5)
  // Distinct from the shared fallback, which is what a wrong lookup would return.
  expect(price.output).not.toBe(getModelPrice('totally-unknown-model').output)
})

test('antigravity reports tokens/cost/model (decoded from the gen_metadata protobuf)', () => {
  expect(HARNESS_CAPABILITIES.antigravity.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.antigravity.cost).toBe(true)
  expect(HARNESS_CAPABILITIES.antigravity.model).toBe(true)
  expect(HARNESS_CAPABILITIES.antigravity.tools).toBe(true)
  // Subagents are their own conversations, not agent invocations on the parent.
  expect(HARNESS_CAPABILITIES.antigravity.agents).toBe(false)
  // D6: line counts are NOT trustworthy — removals need TargetContent, which agy does not write
  // on its normal edit path, so lines_removed is structurally 0. N/A beats a confident fake 0.
  expect(HARNESS_CAPABILITIES.antigravity.gitLines).toBe(false)
})

test('antigravity model ids resolve to real Gemini pricing, never the Sonnet fallback', () => {
  const fallback = getModelPrice('totally-unknown-model')
  for (const id of ['gemini-3.6-flash', 'gemini-3.6-flash-tiered']) {
    const price = getModelPrice(id)
    expect(price.input).toBe(1.5)
    expect(price.output).toBe(7.5)
    expect(price.cacheRead).toBe(0.15)
    expect(price).not.toEqual(fallback)
  }
  // agy can also drive Claude models; the existing prefix match must still win.
  expect(getModelPrice('claude-opus-4-6-thinking').output).toBe(25)
  // The more specific flash-lite key must not be shadowed by `gemini-3.5-flash`.
  expect(getModelPrice('gemini-3.5-flash-lite').output).toBe(2.5)
  expect(getModelPrice('gemini-3.5-flash').output).toBe(9)
})

test('claude is fully capable; gemini and copilot have tokens/cost/model', () => {
  expect(HARNESS_CAPABILITIES.claude.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.claude.agents).toBe(true)
  expect(HARNESS_CAPABILITIES.codex.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.codex.agents).toBe(false)
  // gemini: tokens/cost/model/tools enabled; agents and gitLines not yet supported
  expect(HARNESS_CAPABILITIES.gemini.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.gemini.cost).toBe(true)
  expect(HARNESS_CAPABILITIES.gemini.model).toBe(true)
  expect(HARNESS_CAPABILITIES.gemini.tools).toBe(true)
  expect(HARNESS_CAPABILITIES.gemini.agents).toBe(false)
  expect(HARNESS_CAPABILITIES.gemini.gitLines).toBe(false)
  // copilot: tokens/cost/model/gitLines/tools enabled; agents not supported. `tools` flipped once
  // the adapter actually read `tool.execution_start`, which had been carrying the tool name and its
  // arguments all along — the flag had been out of date, not the data missing.
  expect(HARNESS_CAPABILITIES.copilot.tokens).toBe(true)
  expect(HARNESS_CAPABILITIES.copilot.cost).toBe(true)
  expect(HARNESS_CAPABILITIES.copilot.model).toBe(true)
  expect(HARNESS_CAPABILITIES.copilot.tools).toBe(true)
  expect(HARNESS_CAPABILITIES.copilot.agents).toBe(false)
  expect(HARNESS_CAPABILITIES.copilot.gitLines).toBe(true)
})

test('dynamicWorkflows capability is Claude-only', () => {
  expect(HARNESS_CAPABILITIES.claude.dynamicWorkflows).toBe(true)
  expect(HARNESS_CAPABILITIES.codex.dynamicWorkflows).toBe(false)
  expect(HARNESS_CAPABILITIES.gemini.dynamicWorkflows).toBe(false)
  expect(HARNESS_CAPABILITIES.copilot.dynamicWorkflows).toBe(false)
  expect(HARNESS_CAPABILITIES.antigravity.dynamicWorkflows).toBe(false)
})

describe('normalizeGitRemote', () => {
  test('collapses https, ssh, scp, and git protocols to host/org/repo', () => {
    const cases: [string, string][] = [
      ['https://github.com/org/repo.git', 'github.com/org/repo'],
      ['https://github.com/org/repo', 'github.com/org/repo'],
      ['git@github.com:org/repo.git', 'github.com/org/repo'],
      ['git@github.com:org/repo', 'github.com/org/repo'],
      ['ssh://git@github.com/org/repo', 'github.com/org/repo'],
      ['ssh://git@github.com:22/org/repo.git', 'github.com/org/repo'],
      ['git://github.com/org/repo.git', 'github.com/org/repo'],
      ['github.com/org/repo', 'github.com/org/repo'],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeGitRemote(input)).toBe(expected)
    }
  })

  test('strips embedded credentials incl. CI tokens', () => {
    expect(normalizeGitRemote('https://user:token@github.com/org/repo.git')).toBe('github.com/org/repo')
    expect(normalizeGitRemote('https://x-access-token:ghs_abc123@github.com/org/repo')).toBe('github.com/org/repo')
  })

  test('lowercases host but preserves path case', () => {
    expect(normalizeGitRemote('https://GitHub.com/Org/Repo.git')).toBe('github.com/Org/Repo')
  })

  test('handles trailing slashes and nested paths (self-hosted / subgroups)', () => {
    expect(normalizeGitRemote('https://gitlab.example.com/group/subgroup/repo.git/')).toBe('gitlab.example.com/group/subgroup/repo')
  })

  test('returns "" for non-remotes, local paths, and junk', () => {
    expect(normalizeGitRemote('')).toBe('')
    expect(normalizeGitRemote(undefined)).toBe('')
    expect(normalizeGitRemote(null)).toBe('')
    expect(normalizeGitRemote('file:///home/user/repo.git')).toBe('')
    expect(normalizeGitRemote('/home/user/repo')).toBe('')
    expect(normalizeGitRemote('justastring')).toBe('')
  })

  test('is idempotent — normalizing an already-normalized value is a no-op', () => {
    const once = normalizeGitRemote('git@github.com:org/repo.git')
    expect(normalizeGitRemote(once)).toBe(once)
  })
})

describe('repoShortName', () => {
  test('drops the host, keeping org/repo', () => {
    expect(repoShortName('github.com/org/repo')).toBe('org/repo')
    expect(repoShortName('gitlab.example.com/group/subgroup/repo')).toBe('group/subgroup/repo')
    expect(repoShortName('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// D8 — prefix matching must not resolve a TRUNCATED id to a `-lite` price
// ---------------------------------------------------------------------------

describe('getModelPrice prefix resolution', () => {
  const FALLBACK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 }

  test('every id the Antigravity harness actually reports resolves to its REAL price', () => {
    // Suffixed ids must hit their base model, never the Sonnet fallback.
    expect(getModelPrice('gemini-3.6-flash')).toEqual(MODEL_PRICING['gemini-3.6-flash']!)
    expect(getModelPrice('gemini-3.6-flash-tiered')).toEqual(MODEL_PRICING['gemini-3.6-flash']!)
    expect(getModelPrice('claude-opus-4-6-thinking')).toEqual(MODEL_PRICING['claude-opus-4-6']!)
    for (const id of ['gemini-3.6-flash', 'gemini-3.6-flash-tiered', 'claude-opus-4-6-thinking']) {
      expect(getModelPrice(id)).not.toEqual(FALLBACK)
    }
  })

  test('the LONGEST matching key wins, regardless of key order in the table', () => {
    expect(getModelPrice('gemini-3.5-flash-lite')).toEqual(MODEL_PRICING['gemini-3.5-flash-lite']!)
    expect(getModelPrice('gemini-3.5-flash-lite-preview')).toEqual(MODEL_PRICING['gemini-3.5-flash-lite']!)
    expect(getModelPrice('gemini-3.5-flash')).toEqual(MODEL_PRICING['gemini-3.5-flash']!)
  })

  test('a truncated family id never resolves to a cheaper -lite price', () => {
    // The bug: `key.startsWith(modelId)` used to return whichever key came first, so
    // 'gemini-3.5' silently got Flash-Lite pricing.
    expect(getModelPrice('gemini-3.5')).toEqual(MODEL_PRICING['gemini-3.5-flash']!)
    expect(getModelPrice('gemini-3.5')).not.toEqual(MODEL_PRICING['gemini-3.5-flash-lite']!)
    expect(getModelPrice('gemini-3.1')).toEqual(MODEL_PRICING['gemini-3.1-pro']!)
  })

  test('a version-less id still resolves to its dated key', () => {
    expect(getModelPrice('claude-haiku-4-5')).toEqual(MODEL_PRICING['claude-haiku-4-5-20251001']!)
  })

  test('a partial word is not a match — it falls back', () => {
    expect(getModelPrice('gemini-3.5-fl')).toEqual(FALLBACK)
    expect(getModelPrice('')).toEqual(FALLBACK)
  })
})

// ---------------------------------------------------------------------------
// Multi-model sessions (Antigravity parent + folded sub-agent children)
// ---------------------------------------------------------------------------

describe('sessionModelUsage / sessionCostUSD', () => {
  const base = {
    input_tokens: 100, output_tokens: 10,
    cache_read_input_tokens: 50, cache_creation_input_tokens: 0,
  }

  test('a single-model session yields one entry priced by `model`', () => {
    const entries = sessionModelUsage({ ...base, model: 'gemini-3.6-flash' })
    expect(entries).toHaveLength(1)
    expect(entries[0]![0]).toBe('gemini-3.6-flash')
    expect(entries[0]![1].inputTokens).toBe(100)
    expect(sessionCostUSD({ ...base, model: 'gemini-3.6-flash' })).toBeCloseTo(
      calcCost({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, 'gemini-3.6-flash'),
      12,
    )
  })

  test('a multi-model session is priced per model, not at its single label rate', () => {
    const s = {
      ...base,
      model: 'claude-opus-4-6-thinking',
      model_usage: {
        'claude-opus-4-6-thinking': { inputTokens: 60, outputTokens: 6, cacheReadInputTokens: 30, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
        'gemini-3.6-flash-tiered': { inputTokens: 40, outputTokens: 4, cacheReadInputTokens: 20, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 },
      },
    }
    const cost = sessionCostUSD(s)!
    const atOpusOnly = calcCost({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }, 'claude-opus-4-6-thinking')
    expect(cost).toBeLessThan(atOpusOnly)
    expect(cost).toBeCloseTo(
      calcCost(s.model_usage['claude-opus-4-6-thinking']!, 'claude-opus-4-6-thinking')
      + calcCost(s.model_usage['gemini-3.6-flash-tiered']!, 'gemini-3.6-flash-tiered'),
      12,
    )
  })

  test('no model at all → null, so the caller can use its blended fallback', () => {
    expect(sessionCostUSD({ ...base })).toBeNull()
    expect(sessionCostUSD({ ...base }, 'gemini-3.6-flash')).not.toBeNull()
  })
})

// --- worktrees are not projects -----------------------------------------------------------------

test('canonicalProjectPath folds a worktree back into its project', () => {
  const proj = '/home/u/projects/pulsar'
  expect(canonicalProjectPath(`${proj}/.claude/worktrees/bridge-cse_01HDS3hvd6yDjaWPxedhPrUc`)).toBe(proj)
  // The decoded-path variant that loses the leading dot and doubles the slash.
  expect(canonicalProjectPath('/home/u/prontuario//claude/worktrees/filtro/metricas')).toBe('/home/u/prontuario')
})

test('canonicalProjectPath leaves a real project path alone', () => {
  expect(canonicalProjectPath('/home/u/projects/pulsar')).toBe('/home/u/projects/pulsar')
  expect(canonicalProjectPath('')).toBe('')
  // A directory merely NAMED worktrees is not a worktree root.
  expect(canonicalProjectPath('/home/u/worktrees/thing')).toBe('/home/u/worktrees/thing')
  expect(canonicalProjectPath('/home/u/.claude')).toBe('/home/u/.claude')
})

test('HARNESS_ORDER lists every harness exactly once', () => {
  // The regression this guards: five places used to hardcode the list as a plain array, which
  // TypeScript accepts with a member missing — a new harness silently vanished from the Compare
  // page, the filter bar and the consolidate store.
  expect([...HARNESS_ORDER].sort()).toEqual(Object.keys(HARNESS_CAPABILITIES).sort() as typeof HARNESS_ORDER)
  expect(new Set(HARNESS_ORDER).size).toBe(HARNESS_ORDER.length)
})

test('a gpt-5.6 variant is priced as itself, not as legacy gpt-5', () => {
  // Regression: `gpt-5.6-terra` (what Codex actually reports) prefix-matched the legacy `gpt-5`
  // row and was priced at 1.25/10 instead of 2.5/15 — every Codex session cost half of the truth.
  expect(getModelPrice('gpt-5.6-terra').input).toBe(2.5)
  expect(getModelPrice('gpt-5.6-terra').output).toBe(15)
  expect(getModelPrice('gpt-5.6-sol').output).toBe(30)
  expect(getModelPrice('gpt-5.6-luna').output).toBe(6)
  // The legacy rows still resolve for old sessions.
  expect(getModelPrice('gpt-5').output).toBe(10)
  expect(getModelPrice('gpt-5-mini').output).toBe(2)
})

test('current Anthropic models are priced as themselves, not as the fallback', () => {
  // Regression: `claude-opus-4-8` and `claude-opus-5` were absent from the table AND from the live
  // scrape's name map, so 39 of the heaviest sessions on a real machine were priced at Sonnet's
  // 3/15 instead of Opus's 5/25 — a ~40% understatement, with nothing on screen to hint at it.
  for (const id of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
    expect(getModelPrice(id).input).toBe(5)
    expect(getModelPrice(id).output).toBe(25)
  }
  expect(getModelPrice('claude-fable-5').output).toBe(50)
  // Sonnet 5 introductory pricing, in effect through 2026-08-31.
  expect(getModelPrice('claude-sonnet-5').output).toBe(10)
  // None of them may collide with the fallback rate.
  const fallback = getModelPrice('a-model-that-does-not-exist')
  expect(fallback.output).toBe(15)
  expect(getModelPrice('claude-opus-5').output).not.toBe(fallback.output)
})

test('sessionDay tolerates a start_time an adapter got wrong', () => {
  expect(sessionDay('2026-08-05T10:00:00.000Z')).toBe('2026-08-05')
  // Kimi wrote an epoch number; one such session used to 500 the whole /api/data response.
  expect(sessionDay(1785939883717)).toBe(new Date(1785939883717).toISOString().slice(0, 10))
  expect(sessionDay(undefined)).toBe('')
  expect(sessionDay(null)).toBe('')
  expect(sessionDay({})).toBe('')
  expect(sessionDay(NaN)).toBe('')
  expect(sessionDay(-1)).toBe('')
})

test('normalizeSessionTimes repairs a start_time an adapter wrote as a number', () => {
  const s = normalizeSessionTimes({ start_time: 1785939883717 as unknown as string, end_time: undefined })
  expect(s.start_time).toBe(new Date(1785939883717).toISOString())
  expect(s.end_time).toBeUndefined()   // absent stays absent, never becomes ''
})

test('normalizeSessionTimes leaves a correct session untouched', () => {
  const s = normalizeSessionTimes({ start_time: '2026-08-05T10:00:00.000Z', end_time: '2026-08-05T11:00:00.000Z' })
  expect(s.start_time).toBe('2026-08-05T10:00:00.000Z')
  expect(s.end_time).toBe('2026-08-05T11:00:00.000Z')
})

test('normalizeSessionTimes turns junk into the empty string the pipeline already handles', () => {
  expect(normalizeSessionTimes({ start_time: {} as unknown as string }).start_time).toBe('')
  expect(normalizeSessionTimes({ start_time: NaN as unknown as string }).start_time).toBe('')
})
