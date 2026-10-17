import { describe, expect, test } from 'bun:test'
import { fmtSpan, groupConsecutive, groupPerExchange, groupSpanMs, kindOf, markTrailingRunning, objectOf, stepVerb, stepsOfTurn, summarize, type TurnLike } from './toolActivity'

describe('kindOf — one rule for every harness', () => {
  test.each([
    // claude (shared vocabulary)
    [{ name: 'Bash' }, 'run'], [{ name: 'Read' }, 'read'], [{ name: 'Write' }, 'write'], [{ name: 'Agent' }, 'delegate'],
    // gemini / agy / copilot through `canonical`
    [{ name: 'run_shell_command', canonical: 'Bash' }, 'run'], [{ name: 'view_file', canonical: 'Read' }, 'read'],
    [{ name: 'replace_file_content', canonical: 'Edit' }, 'edit'],
    // harness names the shared map lacks (measured 2026-10-16)
    [{ name: 'exec' }, 'run'], [{ name: 'rg' }, 'search'], [{ name: 'apply_patch' }, 'edit'],
    [{ name: 'google_web_search' }, 'web'], [{ name: 'save_memory' }, 'memory'], [{ name: 'invoke_subagent' }, 'delegate'],
    // MCP in both spellings
    [{ name: 'mcp__agentistics__agentistics_tasks' }, 'mcp'], [{ name: 'mcp_agentistics_agentistics_tasks' }, 'mcp'],
  ] as const)('%o → %s', (call, kind) => expect(kindOf(call)).toBe(kind))

  test('an unknown tool is kept as itself, never dropped', () => {
    expect(kindOf({ name: 'frobnicate' })).toBe('other')
    expect(objectOf({ name: 'frobnicate' }, 'other')).toBe('frobnicate')
  })
  test('a codex exec that is a patch is an edit of the patched file', () => {
    const c = { name: 'exec', detail: 'apply_patch *** Begin Patch\n*** Update File: src/a/b.ts' }
    expect(kindOf(c)).toBe('edit')
    expect(objectOf(c, 'edit')).toBe('b.ts')
  })
  test('a write under a memory directory is a memory, titled', () => {
    const c = { name: 'Edit', detail: '/home/u/.claude/projects/x/memory/agentask-name.md' }
    expect(kindOf(c)).toBe('memory')
    expect(objectOf(c, 'memory')).toBe('Agentask name')
  })
})

describe('summarize', () => {
  const t: TurnLike = { role: 'assistant', text: '', tools: [
    { name: 'Read', detail: 'a.ts' }, { name: 'Write', detail: 'b.md' },
    { name: 'Edit', detail: '/m/memory/x.md' }, { name: 'Edit', detail: '/m/memory/y.md' }, { name: 'Edit', detail: '/m/memory/z.md' },
  ] }
  test('what changed comes first; done reads in the past', () => {
    expect(summarize(stepsOfTurn(t), false, true)).toBe('Criou um arquivo, atualizou 3 memórias e leu um arquivo')
    expect(summarize(stepsOfTurn(t), false, false)).toBe('Created a file, updated 3 memories and read a file')
  })
  test('running reads in the gerund (the owner’s wording)', () => {
    expect(summarize(stepsOfTurn({ ...t, pending: true }), true, true)).toBe('Criando um arquivo, atualizando 3 memórias e lendo um arquivo')
  })
  test('more than three kinds collapse into a count', () => {
    const many: TurnLike = { role: 'assistant', text: '', tools: [{ name: 'Write' }, { name: 'Bash' }, { name: 'Grep' }, { name: 'Read' }, { name: 'Read' }] }
    expect(summarize(stepsOfTurn(many), false, true)).toBe('Criou um arquivo, executou um comando, fez uma busca e mais 2 ações')
  })
})

describe('steps and groups', () => {
  const turns: TurnLike[] = [
    { role: 'user', at: '2026-10-16T14:00:00Z', text: 'go' },
    { role: 'assistant', at: '2026-10-16T14:00:05Z', text: 'ok', tools: [{ name: 'Read', detail: 'a' }] },
    { role: 'assistant', at: '2026-10-16T14:00:20Z', text: '', tools: [{ name: 'Bash', detail: 'x', failed: true }] },
    { role: 'assistant', at: '2026-10-16T14:01:25Z', text: 'done' },
  ]
  test('B groups the calls between two sentences, timed to the next sentence', () => {
    const items = groupConsecutive(turns)
    expect(items.map(i => i.type)).toEqual(['turn', 'turn', 'activity', 'turn'])
    const g = items[2]!.type === 'activity' ? items[2]!.group : null
    expect(g!.steps.map(s => s.status)).toEqual(['done', 'error'])
    expect(g!.endedAt).toBe('2026-10-16T14:01:25Z')
  })
  test('A puts ONE group right after the person, before what was said', () => {
    expect(groupPerExchange(turns).map(i => i.type)).toEqual(['turn', 'activity', 'turn', 'turn'])
  })
  test('the last call of a pending turn is the running one', () => {
    const s = stepsOfTurn({ role: 'assistant', text: '', pending: true, tools: [{ name: 'Read' }, { name: 'Bash' }] })
    expect(s.map(x => x.status)).toEqual(['done', 'running'])
  })
  test('fmtSpan', () => {
    expect(fmtSpan(80_000)).toBe('1 min 20 s')
    expect(fmtSpan(45_000)).toBe('45 s')
    expect(fmtSpan(null)).toBeNull()
  })
})

describe('CHAT.ACTIVITY wiring', () => {
  type G = import('./toolActivity').ActivityGroup
  const groupOf = (i: unknown) => (i as { type: 'activity'; group: G }).group
  const t = (over: Partial<TurnLike>): TurnLike => ({ role: 'assistant', text: '', ...over })
  const turns: TurnLike[] = [
    t({ role: 'user', text: 'go', at: '2026-10-16T10:00:00Z' }),
    t({ text: 'vou ler', at: '2026-10-16T10:00:05Z' }),
    t({ at: '2026-10-16T10:00:10Z', tools: [{ name: 'Read', detail: '/a/x.ts' }, { name: 'Bash', detail: 'ls' }] }),
    t({ at: '2026-10-16T10:01:30Z', tools: [{ name: 'Write', detail: '/a/y.ts' }] }),
    t({ text: 'pronto', at: '2026-10-16T10:01:40Z' }),
  ]

  test('consecutive tool turns between two texts are one group, with its span', () => {
    const items = groupConsecutive(turns)
    expect(items.map(i => i.type)).toEqual(['turn', 'turn', 'activity', 'turn'])
    const g = groupOf(items[2])
    expect(g.steps).toHaveLength(3)
    expect(fmtSpan(groupSpanMs(g, 0))).toBe('1 min 30 s')
  })

  test('summary reads in the past when done, the gerund while running, in pt and en', () => {
    const g = groupOf(groupConsecutive(turns)[2])
    expect(summarize(g.steps, false, true)).toBe('Criou um arquivo, executou um comando e leu um arquivo')
    expect(summarize(g.steps, false, false)).toBe('Created a file, ran a command and read a file')
    expect(summarize(g.steps, true, true)).toBe('Criando um arquivo, executando um comando e lendo um arquivo')
  })

  test('live → collapsed: the trailing run is running only while the session works', () => {
    const open = groupConsecutive(turns.slice(0, 4))
    const live = markTrailingRunning(open, true)
    const done = markTrailingRunning(open, false)
    const gl = groupOf(live[live.length - 1])
    const gd = groupOf(done[done.length - 1])
    expect(gl.running).toBe(true)
    expect(gl.steps.map(s => s.status)).toEqual(['done', 'done', 'running'])
    expect(gl.endedAt).toBeUndefined()
    expect(gd.running).toBe(false)
    expect(markTrailingRunning(groupConsecutive(turns), true).at(-1)?.type).toBe('turn')
  })

  test('a failed step renders "Falhou"/"Failed" (TODO engine: readers do not set tools[].failed yet)', () => {
    const steps = stepsOfTurn(t({ tools: [{ name: 'Bash', detail: 'false', failed: true }] }))
    expect(steps[0]!.status).toBe('error')
    expect(stepVerb(steps[0]!, true)).toBe('Falhou')
    expect(stepVerb(steps[0]!, false)).toBe('Failed')
  })

  test('every harness name resolves to a kind (claude, codex, gemini, copilot, agy, kimi)', () => {
    const calls = [
      { name: 'Bash' }, { name: 'exec' }, { name: 'run_shell_command', canonical: 'Bash' },
      { name: 'rg' }, { name: 'search_web' }, { name: 'Read' },
    ]
    expect(calls.map(kindOf)).toEqual(['run', 'run', 'run', 'search', 'web', 'read'])
  })
})

describe('CHAT.ACTIVITY fix r1', () => {
  const mk = (at: string, ref: string, pending = false): TurnLike => ({ at, role: 'assistant', text: '', pending, tools: [{ name: 'Bash', detail: 'ls', ref }] })
  const user: TurnLike = { at: '2026-10-16T10:00:00Z', role: 'user', text: 'go' }

  test('not working: a pending trailing run is collapsed — no running step, no spinner flag', () => {
    const items = markTrailingRunning(groupConsecutive([user, mk('2026-10-16T10:00:01Z', 'a', true)]), false)
    const g = (items.at(-1) as { type: 'activity'; group: import('./toolActivity').ActivityGroup }).group
    expect(g.running).toBe(false)
    expect(g.steps.map(s => s.status)).toEqual(['unfinished'])
    expect(stepVerb(g.steps[0]!, false)).toBe('No result')
  })

  test('group keys are stable when earlier messages load (window shift)', () => {
    const base = [user, mk('2026-10-16T10:00:01Z', 'a'), mk('2026-10-16T10:00:02Z', 'b')]
    const older: TurnLike[] = [{ at: '2026-10-16T09:00:00Z', role: 'user', text: 'earlier' }, { at: '2026-10-16T09:00:01Z', role: 'assistant', text: 'hi' }]
    const keys = (ts: TurnLike[]) => groupConsecutive(ts).filter(i => i.type === 'activity').map(i => (i as { group: { key: string } }).group.key)
    expect(keys([...older, ...base])).toEqual(keys(base))
  })

  test('compacting after tools: treated as not working, the last tool is not running', () => {
    const items = markTrailingRunning(groupConsecutive([user, mk('2026-10-16T10:00:01Z', 'a', true)]), false)
    expect(JSON.stringify(items)).not.toContain('"status":"running"')
  })
})
