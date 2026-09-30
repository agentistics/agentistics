import { describe, expect, test } from 'bun:test'
import type { ToolContext } from './contract.ts'
import { defineTool, NO_GRANT_SENTENCE } from './define.ts'
import { runTool } from './gate.ts'
import { mintGrant } from './grant.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from './testing.ts'

function probeTool() {
  const ran: string[] = []
  const tool = defineTool<{ path: string }>({
    name: 'probe.write',
    description: 'test',
    kind: 'file',
    permission: 'ask',
    inputSchema: { type: 'object' },
    parse: (i) => (typeof i === 'object' && i !== null && typeof (i as { path?: unknown }).path === 'string'
      ? { path: (i as { path: string }).path }
      : 'path is required'),
    subjects: async (i) => [{ action: 'write', path: `/ws/${i.path}`, op: 'create' }],
    run: async (i) => { ran.push(i.path); return { ok: true, modelText: `wrote ${i.path}`, facts: { filesTouched: [i.path] } } },
  })
  return { tool, ran }
}

const scope = () => ({ workspaceRoot: '/ws', cwd: '/ws', signal: new AbortController().signal })

describe('gate', () => {
  test('allowed: runs once, one requested and one terminal completed', async () => {
    const { tool, ran } = probeTool()
    const events = recordingEvents()
    const r = await runTool(tool, { path: 'a' }, scope(), { policy: scriptedPolicy('allow'), events, content: memoryContent() })
    expect(r.status).toBe('completed')
    expect(ran).toEqual(['a'])
    expect(events.log.map(e => e.event)).toEqual(['requested', 'policyRequested', 'policyDecided', 'completed'])
  })

  test('denied: nothing runs, the model gets the sentence, the denial is the terminal event', async () => {
    const { tool, ran } = probeTool()
    const events = recordingEvents()
    const r = await runTool(tool, { path: 'a' }, scope(), { policy: scriptedPolicy('deny'), events, content: memoryContent() })
    expect(r.status).toBe('denied')
    expect(ran).toEqual([])
    expect(r.outcome.modelText).toBe('Refused by the test policy.')
    expect(events.log.map(e => e.event)).toEqual(['requested', 'policyRequested', 'policyDecided'])
  })

  test('a policy that throws is a denial (fail closed)', async () => {
    const { tool, ran } = probeTool()
    const r = await runTool(tool, { path: 'a' }, scope(), {
      policy: { evaluate: async () => { throw new Error('boom') } },
      events: recordingEvents(),
      content: memoryContent(),
    })
    expect(r.status).toBe('denied')
    expect(ran).toEqual([])
  })

  test('invalid input never reaches the policy', async () => {
    const { tool } = probeTool()
    const policy = scriptedPolicy('allow')
    const r = await runTool(tool, { nope: 1 }, scope(), { policy, events: recordingEvents(), content: memoryContent() })
    expect(r.outcome.error?.class).toBe('invalid-input')
    expect(policy.seen).toHaveLength(0)
  })

  test('execute without a grant, a forged grant, a grant for other subjects, or a spent grant does not run', async () => {
    const { tool, ran } = probeTool()
    const ctx = { workspaceRoot: '/ws', cwd: '/ws', signal: new AbortController().signal, toolExecutionId: 'tx_1', now: () => new Date() } as ToolContext
    expect((await tool.execute({ path: 'a' }, ctx, undefined)).modelText).toBe(NO_GRANT_SENTENCE)
    const forged = { toolExecutionId: 'tx_1', subjects: [{ action: 'write', path: '/ws/a', op: 'create' }] }
    expect((await tool.execute({ path: 'a' }, ctx, forged)).ok).toBe(false)
    const other = mintGrant('tx_1', [{ action: 'write', path: '/ws/b', op: 'create' }])
    expect((await tool.execute({ path: 'a' }, ctx, other)).ok).toBe(false)
    const good = mintGrant('tx_1', [{ action: 'write', path: '/ws/a', op: 'create' }])
    expect((await tool.execute({ path: 'a' }, ctx, good)).ok).toBe(true)
    expect((await tool.execute({ path: 'a' }, ctx, good)).ok).toBe(false)
    expect(ran).toEqual(['a'])
  })
})
