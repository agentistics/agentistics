import { describe, expect, test } from 'bun:test'
import { fmtSpan, groupConsecutive, groupPerExchange, kindOf, objectOf, stepsOfTurn, summarize, type TurnLike } from './toolActivity'

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
