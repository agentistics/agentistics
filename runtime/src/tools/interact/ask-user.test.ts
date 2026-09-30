import { describe, expect, test } from 'bun:test'
import type { PersonAnswer, PersonAsker, ToolErrorClass } from '../contract.ts'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedAsker, scriptedPolicy } from '../testing.ts'
import { createAskUserTool } from './ask-user.ts'

const scope = () => ({ workspaceRoot: '/ws', cwd: '/ws', signal: new AbortController().signal })
const question = { question: 'Which fix?', options: [{ label: 'A' }, { label: 'B' }] }

describe('ask.user', () => {
  test('denied: the asker is never called, model gets the policy refusal sentence', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, choice: 0 }])
    const r = await runTool(tool, question, scope(), {
      policy: scriptedPolicy('deny'),
      events: recordingEvents(),
      content: memoryContent(),
      asker,
    })
    expect(r.status).toBe('denied')
    expect(asker.asked).toEqual([])
    expect(r.outcome.modelText).toBe('Refused by the test policy.')
  })

  test('answer by option: modelText names the chosen label', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, choice: 1 }])
    const r = await runTool(tool, question, scope(), {
      policy: scriptedPolicy('allow'),
      events: recordingEvents(),
      content: memoryContent(),
      asker,
    })
    expect(r.status).toBe('completed')
    expect(r.outcome.modelText).toBe('The person chose: "B".')
    expect(asker.asked).toHaveLength(1)
    expect(asker.asked[0]?.kind).toBe('question')
    expect(asker.asked[0]?.options).toEqual([{ label: 'A' }, { label: 'B' }])
  })

  test('free text alongside a chosen option is included in modelText', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, choice: 0, text: 'also do X' }])
    const r = await runTool(tool, { ...question, allowFreeText: true }, scope(), {
      policy: scriptedPolicy('allow'),
      events: recordingEvents(),
      content: memoryContent(),
      asker,
    })
    expect(r.outcome.modelText).toBe('The person chose: "A". They also added: "also do X"')
  })

  test('a pure free-text answer (no option chosen) is reported as such', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, text: 'neither, do Z instead' }])
    const r = await runTool(tool, { ...question, allowFreeText: true }, scope(), {
      policy: scriptedPolicy('allow'),
      events: recordingEvents(),
      content: memoryContent(),
      asker,
    })
    expect(r.outcome.modelText).toBe('The person answered: "neither, do Z instead"')
  })

  test('an out-of-range choice index fails internal, in words', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, choice: 5 }])
    const r = await runTool(tool, question, scope(), {
      policy: scriptedPolicy('allow'),
      events: recordingEvents(),
      content: memoryContent(),
      asker,
    })
    expect(r.outcome.ok).toBe(false)
    expect(r.outcome.error?.class).toBe('internal')
  })

  test('unanswered: each reason maps to its own error class and is never treated as an answer', async () => {
    const cases: Array<[PersonAnswer, ToolErrorClass]> = [
      [{ answered: false, reason: 'timeout' }, 'timeout'],
      [{ answered: false, reason: 'cancelled' }, 'killed'],
      [{ answered: false, reason: 'unavailable' }, 'unavailable'],
    ]
    for (const [answer, cls] of cases) {
      const tool = createAskUserTool()
      const asker = scriptedAsker([answer])
      const r = await runTool(tool, question, scope(), {
        policy: scriptedPolicy('allow'),
        events: recordingEvents(),
        content: memoryContent(),
        asker,
      })
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.error?.class).toBe(cls)
      expect(r.outcome.result).toBeUndefined()
    }
  })

  test('no asker in context: fails unavailable, and no question is ever asked', async () => {
    const tool = createAskUserTool()
    const r = await runTool(tool, question, scope(), {
      policy: scriptedPolicy('allow'),
      events: recordingEvents(),
      content: memoryContent(),
      // deliberately no `asker`
    })
    expect(r.outcome.ok).toBe(false)
    expect(r.outcome.error?.class).toBe('unavailable')
    expect(r.outcome.modelText).toContain('No person can be reached')
  })

  test('abort mid-question: an asker that awaits the signal is reported as cancelled, never as an answer', async () => {
    const tool = createAskUserTool()
    const controller = new AbortController()
    let notifyAsked!: () => void
    const asked = new Promise<void>((resolve) => {
      notifyAsked = resolve
    })
    const asker: PersonAsker = {
      ask: (_q, signal) => {
        notifyAsked()
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ answered: false, reason: 'cancelled' }))
        })
      },
    }

    const pending = runTool(
      tool,
      question,
      { workspaceRoot: '/ws', cwd: '/ws', signal: controller.signal },
      { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent(), asker },
    )
    await asked // the asker has genuinely been called and is now waiting
    controller.abort()
    const r = await pending

    expect(r.outcome.ok).toBe(false)
    expect(r.outcome.error?.class).toBe('killed')
    expect(r.outcome.modelText).toContain('cancelled')
  })

  test('the subject is fixed: [{action: "ask-user"}], regardless of input', async () => {
    const tool = createAskUserTool()
    const policy = scriptedPolicy('allow')
    const asker = scriptedAsker([{ answered: true, choice: 0 }])
    await runTool(tool, question, scope(), { policy, events: recordingEvents(), content: memoryContent(), asker })
    expect(policy.seen).toHaveLength(1)
    expect(policy.seen[0]?.subjects).toEqual([{ action: 'ask-user' }])
  })

  test('options bounds: fewer than 1 or more than 6 are refused as invalid-input, before the asker is touched', async () => {
    const tool = createAskUserTool()
    const asker = scriptedAsker([{ answered: true, choice: 0 }])
    const deps = { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent(), asker }

    const empty = await runTool(tool, { question: 'q', options: [] }, scope(), deps)
    expect(empty.outcome.error?.class).toBe('invalid-input')

    const seven = await runTool(
      tool,
      { question: 'q', options: Array.from({ length: 7 }, (_, i) => ({ label: `opt${i}` })) },
      scope(),
      deps,
    )
    expect(seven.outcome.error?.class).toBe('invalid-input')
    expect(asker.asked).toEqual([])
  })
})
