import { describe, expect, test } from 'bun:test'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { createPlanTool } from './plan.ts'

const scope = () => ({ workspaceRoot: '/ws', cwd: '/ws', signal: new AbortController().signal })

describe('task.plan', () => {
  test('denied: plan unchanged, model gets the policy refusal sentence', async () => {
    const { tool, plan } = createPlanTool()
    const r = await runTool(tool, { steps: [{ text: 'a', status: 'pending' }] }, scope(), {
      policy: scriptedPolicy('deny'),
      events: recordingEvents(),
      content: memoryContent(),
    })
    expect(r.status).toBe('denied')
    expect(plan()).toEqual([])
    expect(r.outcome.modelText).toBe('Refused by the test policy.')
  })

  test('allowed: replaces the plan and echoes it compactly with counts', async () => {
    const { tool, plan } = createPlanTool()
    const r = await runTool(
      tool,
      {
        steps: [
          { text: 'read the spec', status: 'completed' },
          { text: 'write the code', status: 'in_progress' },
          { text: 'ship it', status: 'pending' },
        ],
      },
      scope(),
      { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() },
    )
    expect(r.status).toBe('completed')
    expect(plan()).toHaveLength(3)
    expect(r.outcome.modelText).toContain('3 steps')
    expect(r.outcome.modelText).toContain('1 pending, 1 in progress, 1 completed')
    expect(r.outcome.modelText).toContain('write the code')
  })

  test('a second call REPLACES the whole plan, it does not merge it', async () => {
    const { tool, plan } = createPlanTool()
    const deps = { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() }
    await runTool(
      tool,
      { steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] },
      scope(),
      deps,
    )
    await runTool(tool, { steps: [{ text: 'c', status: 'pending' }] }, scope(), deps)
    expect(plan()).toEqual([{ text: 'c', status: 'pending' }])
  })

  test('two in_progress steps are refused as invalid-input, before the policy, and the plan is left as it was', async () => {
    const { tool, plan } = createPlanTool()
    const policy = scriptedPolicy('allow')
    const deps = { policy, events: recordingEvents(), content: memoryContent() }
    await runTool(tool, { steps: [{ text: 'a', status: 'in_progress' }] }, scope(), deps)
    expect(plan()).toEqual([{ text: 'a', status: 'in_progress' }])

    const r = await runTool(
      tool,
      { steps: [{ text: 'x', status: 'in_progress' }, { text: 'y', status: 'in_progress' }] },
      scope(),
      deps,
    )
    expect(r.outcome.error?.class).toBe('invalid-input')
    expect(r.outcome.modelText).toContain('one step may be in_progress')
    expect(plan()).toEqual([{ text: 'a', status: 'in_progress' }])
    expect(policy.seen).toHaveLength(1) // only the first (valid) call ever reached the policy
  })

  test('too many steps, and text over the length limit, are refused as invalid-input', async () => {
    const { tool } = createPlanTool()
    const deps = { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() }
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ text: `step ${i}`, status: 'pending' as const }))
    const r1 = await runTool(tool, { steps: tooMany }, scope(), deps)
    expect(r1.outcome.error?.class).toBe('invalid-input')

    const r2 = await runTool(tool, { steps: [{ text: 'x'.repeat(501), status: 'pending' }] }, scope(), deps)
    expect(r2.outcome.error?.class).toBe('invalid-input')
  })

  test('an unrecognised status is refused as invalid-input', async () => {
    const { tool } = createPlanTool()
    const deps = { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() }
    const r = await runTool(tool, { steps: [{ text: 'a', status: 'done' }] }, scope(), deps)
    expect(r.outcome.error?.class).toBe('invalid-input')
  })

  test('the subject is fixed: [{action: "plan"}], regardless of input', async () => {
    const { tool } = createPlanTool()
    const policy = scriptedPolicy('allow')
    await runTool(tool, { steps: [{ text: 'a', status: 'pending' }] }, scope(), {
      policy,
      events: recordingEvents(),
      content: memoryContent(),
    })
    expect(policy.seen).toHaveLength(1)
    expect(policy.seen[0]?.subjects).toEqual([{ action: 'plan' }])
  })

  test('an empty plan clears it, and says so', async () => {
    const { tool, plan } = createPlanTool()
    const deps = { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() }
    await runTool(tool, { steps: [{ text: 'a', status: 'pending' }] }, scope(), deps)
    const r = await runTool(tool, { steps: [] }, scope(), deps)
    expect(r.status).toBe('completed')
    expect(plan()).toEqual([])
    expect(r.outcome.modelText).toBe('Plan cleared — no steps.')
  })
})
