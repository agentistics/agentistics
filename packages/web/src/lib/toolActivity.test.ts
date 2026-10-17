import { describe, expect, test } from 'bun:test'
import { fmtSpan, groupConsecutive, groupPerExchange, groupSpanMs, kindOf, markTrailingRunning, objectOf, stepVerb, stepsOfTurn, summarize, type ActivityKind, type ActivityStep, type TurnLike } from './toolActivity'

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


describe('CHAT.ACTIVITY P3 — generic tool grammar', () => {
  const cases = ([true, false] as const).flatMap(pt => [true, false].flatMap(running =>
    [0, 1, 2].flatMap(commands => [0, 1, 2].flatMap(mcp => [0, 1, 2].map(other => {
      const calls = [
        ...Array.from({ length: commands }, () => ({ name: 'Bash' })),
        ...Array.from({ length: mcp }, () => ({ name: 'mcp__test__call' })),
        ...Array.from({ length: other }, () => ({ name: 'unknown_tool' })),
      ]
      // Explicit singular/plural wording, including a generic-only run and an empty run.
      const runWords = pt
        ? (running ? ['', 'executando um comando', 'executando 2 comandos'] : ['', 'executou um comando', 'executou 2 comandos'])
        : (running ? ['', 'running a command', 'running 2 commands'] : ['', 'ran a command', 'ran 2 commands'])
      const mcpWords = pt
        ? (running ? ['', 'usando uma ferramenta MCP', 'usando 2 ferramentas MCP'] : ['', 'usou uma ferramenta MCP', 'usou 2 ferramentas MCP'])
        : (running ? ['', 'using an MCP tool', 'using 2 MCP tools'] : ['', 'used an MCP tool', 'used 2 MCP tools'])
      const genericWords = commands + mcp > 0
        ? (pt ? ['', 'mais 1 ferramenta', 'mais 2 ferramentas'] : ['', '1 other tool', '2 other tools'])
        : pt
          ? (running ? ['', 'usando uma ferramenta', 'usando 2 ferramentas'] : ['', 'usou uma ferramenta', 'usou 2 ferramentas'])
          : (running ? ['', 'using a tool', 'using 2 tools'] : ['', 'used a tool', 'used 2 tools'])
      const phrases = [runWords[commands], mcpWords[mcp], genericWords[other]].filter(Boolean) as string[]
      const joined = phrases.length < 2 ? (phrases[0] ?? '')
        : phrases.length === 2 ? phrases.join(pt ? ' e ' : ' and ')
          : `${phrases[0]}, ${phrases[1]} ${pt ? 'e' : 'and'} ${phrases[2]}`
      return { pt, running, commands, mcp, other, calls, expected: joined ? joined[0]!.toUpperCase() + joined.slice(1) : '' }
    })))))

  test.each(cases)('$pt / $running: $commands commands, $mcp MCP, $other generic', ({ pt, running, calls, expected }) => {
    const steps = stepsOfTurn({ role: 'assistant', text: '', tools: calls })
    expect(summarize(steps, running, pt)).toBe(expected)
  })

  test.each([
    [true, 'Criou um arquivo, executou um comando, fez uma busca, mais 2 ações e mais 2 ferramentas'],
    [false, 'Created a file, ran a command, ran a search, 2 more actions and 2 other tools'],
  ] as const)('generic counts survive the phrase limit (%s)', (pt, expected) => {
    const steps = stepsOfTurn({ role: 'assistant', text: '', tools: [
      { name: 'Write' }, { name: 'Bash' }, { name: 'Grep' }, { name: 'Read' }, { name: 'Read' },
      { name: 'unknown_tool' }, { name: 'another_tool' },
    ] })
    expect(summarize(steps, false, pt)).toBe(expected)
  })
})

describe('CHAT.ACTIVITY P3 — step verbs', () => {
  const words: [ActivityKind, string, string, string, string][] = [
    ['read', 'Leu', 'Read', 'Lendo', 'Reading'],
    ['edit', 'Editou', 'Edited', 'Editando', 'Editing'],
    ['write', 'Criou', 'Created', 'Criando', 'Creating'],
    ['run', 'Executou', 'Ran', 'Executando', 'Running'],
    ['search', 'Buscou', 'Searched', 'Buscando', 'Searching'],
    ['web', 'Consultou', 'Looked up', 'Consultando', 'Looking up'],
    ['memory', 'Atualizou memória', 'Memory updated', 'Atualizando memória', 'Updating memory'],
    ['delegate', 'Delegou', 'Delegated', 'Delegando', 'Delegating'],
    ['plan', 'Atualizou o plano', 'Plan updated', 'Atualizando o plano', 'Updating the plan'],
    ['skill', 'Carregou skill', 'Skill loaded', 'Carregando skill', 'Loading skill'],
    ['mcp', 'Usou', 'Used', 'Usando', 'Using'],
    ['other', 'Usou', 'Used', 'Usando', 'Using'],
  ]
  test.each(words)('%s uses active past in pt and preserves en', (kind, pastPt, pastEn, doingPt, doingEn) => {
    const step: ActivityStep = { kind, name: kind, object: 'target', status: 'done' }
    expect(stepVerb(step, true)).toBe(pastPt)
    expect(stepVerb(step, false)).toBe(pastEn)
    expect(stepVerb({ ...step, status: 'running' }, true)).toBe(doingPt)
    expect(stepVerb({ ...step, status: 'running' }, false)).toBe(doingEn)
    expect(stepVerb({ ...step, status: 'unfinished' }, true)).toBe('Sem resultado')
    expect(stepVerb({ ...step, status: 'unfinished' }, false)).toBe('No result')
    expect(stepVerb({ ...step, status: 'error' }, true)).toBe('Falhou')
    expect(stepVerb({ ...step, status: 'error' }, false)).toBe('Failed')
  })
})

describe('CHAT.ACTIVITY P3 — patch targets across harnesses', () => {
  test.each([
    ['apply_patch', undefined, '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch', 'a.ts'],
    ['apply_patch', 'Edit', '*** Begin Patch\n*** Add File: src/new file.ts\n+content\n*** End Patch', 'new file.ts'],
    ['apply_patch', undefined, '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch', 'old.ts'],
    ['apply_patch', undefined, '*** Begin Patch\r\n*** Update File: src/a.ts\r\n*** Add File: src/b.ts\r\n*** Delete File: src/c.ts\r\n*** Update File: src/a.ts\r\n*** End Patch', 'a.ts, b.ts, c.ts'],
    ['exec', undefined, "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch\nPATCH", 'a.ts, b.ts'],
    ['apply_patch', undefined, undefined, 'apply_patch'],
    ['Edit', undefined, '/repo/src/plain.ts', 'plain.ts'],
  ] as const)('%s / %s extracts %s', (name, canonical, detail, expected) => {
    const step = stepsOfTurn({ role: 'assistant', text: '', tools: [{ name, canonical, detail }] })[0]!
    expect(step.kind).toBe('edit')
    expect(step.object).toBe(expected)
    expect(step.detail).toBe(detail)
    for (const pt of [true, false]) {
      expect(stepVerb(step, pt)).toBe(pt ? 'Editou' : 'Edited')
    }
  })
})

describe('CHAT.ACTIVITY P3 — unanswered steps are separate from completed activity', () => {
  test.each([
    [false, false, 0, 1, '1 step without a result'],
    [true, false, 0, 1, '1 passo sem resultado'],
    [false, false, 0, 2, '2 steps without a result'],
    [true, false, 0, 2, '2 passos sem resultado'],
    [false, false, 1, 1, 'Read a file · 1 step without a result'],
    [true, false, 1, 1, 'Leu um arquivo · 1 passo sem resultado'],
    [false, false, 2, 2, 'Read 2 files · 2 steps without a result'],
    [true, false, 2, 2, 'Leu 2 arquivos · 2 passos sem resultado'],
    [false, true, 1, 1, 'Reading a file · 1 step without a result'],
    [true, true, 1, 1, 'Lendo um arquivo · 1 passo sem resultado'],
  ] as const)('%s / running %s / %s read / %s unanswered', (pt, running, reads, unanswered, expected) => {
    const steps = stepsOfTurn({ role: 'assistant', text: '', tools: Array.from({ length: reads }, () => ({ name: 'Read' })) })
    const pending: ActivityStep[] = Array.from({ length: unanswered }, () => ({ kind: 'run', name: 'Bash', object: 'ls', status: 'unfinished' }))
    expect(summarize([...steps, ...pending], running, pt)).toBe(expected)
  })

  test.each([
    [true, 'Usou uma ferramenta MCP · 1 passo sem resultado'],
    [false, 'Used an MCP tool · 1 step without a result'],
  ] as const)('unfinished generic tool does not inflate other-tool counts (%s)', (pt, expected) => {
    const steps = stepsOfTurn({ role: 'assistant', text: '', tools: [{ name: 'mcp__test__call' }, { name: 'unknown_tool' }], pending: true })
    const items = markTrailingRunning([{ type: 'activity', group: { key: 'pending', steps, running: true } }], false)
    const group = (items[0] as { type: 'activity'; group: import('./toolActivity').ActivityGroup }).group
    expect(summarize(group.steps, group.running, pt)).toBe(expected)
  })
})
