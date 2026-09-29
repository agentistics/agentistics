import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPLETION_SETTINGS,
  emptyCompletionState,
  evaluateCompletion,
  foldBlocked,
  foldToolResult,
  foldTurn,
  type CompletionPlanStep,
  type CompletionSettings,
  type CompletionState,
} from './gate.ts'

const S = DEFAULT_COMPLETION_SETTINGS
const open2: CompletionPlanStep[] = [
  { text: 'write parser', status: 'completed' },
  { text: 'wire loop', status: 'in_progress' },
  { text: 'add tests', status: 'pending' },
]
const allDone: CompletionPlanStep[] = open2.map(s => ({ ...s, status: 'completed' as const }))

function evalAt(state: CompletionState, plan: readonly CompletionPlanStep[], settings: CompletionSettings = S, turnAvailable = true) {
  return evaluateCompletion({ state, plan, settings, turnAvailable })
}

/** A turn in which a tool returned `digest`. */
function toolTurn(state: CompletionState, plan: readonly CompletionPlanStep[], digest: string): CompletionState {
  return foldTurn(foldToolResult(state, { toolName: 'probe', kind: 'other', ok: true, resultDigest: digest }), plan)
}

describe('Rule 1 — open plan items', () => {
  test('open items and K unspent: block with a fact-stating message naming the open items', () => {
    const st = foldTurn(emptyCompletionState, open2)
    const v = evalAt(st, open2)
    expect(v.allow).toBe(false)
    if (v.allow) return
    expect(v.rule).toBe('open-plan')
    expect(v.attempt).toBe(1)
    expect(v.openItems).toBe(2)
    expect(v.message).toContain('2 plan items are still open')
    expect(v.message).toContain('[~] wire loop')
    expect(v.message).toContain('[ ] add tests')
    expect(v.message).not.toContain('write parser')
  })

  test('the same turn with K spent releases forced-limit (acceptance #1)', () => {
    let st = foldTurn(emptyCompletionState, open2)
    st = foldBlocked(foldBlocked(st, 'open-plan'), 'open-plan')
    const v = evalAt(st, open2)
    expect(v).toMatchObject({ allow: true, reason: 'forced-limit', openItems: 2 })
  })

  test('no plan, no gate (acceptance #3) — and nothing to report', () => {
    const st = foldTurn(emptyCompletionState, [])
    expect(evalAt(st, [])).toMatchObject({ allow: true, reason: null, quiet: true })
  })

  test('a plan whose steps are all completed is not blocked; after a block it releases satisfied', () => {
    expect(evalAt(foldTurn(emptyCompletionState, allDone), allDone)).toMatchObject({ allow: true, reason: null })
    const engaged = foldBlocked(foldTurn(emptyCompletionState, open2), 'open-plan')
    expect(evalAt(foldTurn(engaged, allDone), allDone)).toMatchObject({ allow: true, reason: 'satisfied', quiet: false })
  })

  test('no model turn left: release run-budget instead of blocking', () => {
    const st = foldTurn(emptyCompletionState, open2)
    expect(evalAt(st, open2, S, false)).toMatchObject({ allow: true, reason: 'run-budget' })
  })

  test('the message states facts only — no instruction to spend or approve', () => {
    const v = evalAt(foldTurn(emptyCompletionState, open2), open2)
    if (v.allow) throw new Error('expected block')
    expect(v.message).not.toMatch(/\b(approve|spend|you must|please)\b/i)
  })
})

describe('Rule 2 — no progress', () => {
  test('open set unchanged and no distinct tool result over N turns: release no-progress (acceptance #2)', () => {
    let st = foldTurn(emptyCompletionState, open2) // the plan appears: progress
    expect(st.stagnant).toBe(0)
    st = toolTurn(st, open2, 'd1') // a new result: progress
    expect(st.stagnant).toBe(0)
    st = toolTurn(st, open2, 'd1') // same result again
    st = toolTurn(st, open2, 'd1')
    st = foldTurn(st, open2) // the end-turn itself
    expect(st.stagnant).toBe(3)
    expect(evalAt(st, open2)).toMatchObject({ allow: true, reason: 'no-progress' })
    expect(st.forced).toBe(0)
  })

  test('a changed open set resets the window', () => {
    let st = foldTurn(emptyCompletionState, open2)
    st = foldTurn(st, open2)
    st = foldTurn(st, open2)
    expect(st.stagnant).toBe(2)
    const moved = open2.map((s, i) => (i === 1 ? { ...s, status: 'completed' as const } : s))
    st = foldTurn(st, moved)
    expect(st.stagnant).toBe(0)
  })

  test('a distinct tool result resets the window', () => {
    let st = foldTurn(emptyCompletionState, open2)
    st = foldTurn(st, open2)
    st = toolTurn(st, open2, 'new')
    expect(st.stagnant).toBe(0)
  })
})

describe('Rule 3 — verification after edit (opt-in)', () => {
  const on: CompletionSettings = { ...S, requireVerificationAfterEdit: true }
  const edit = (st: CompletionState) => foldToolResult(st, { toolName: 'file.patch', kind: 'file', ok: true, resultDigest: 'e' })
  const shell = (st: CompletionState, exitCode: number | undefined) =>
    foldToolResult(st, { toolName: 'shell.start', kind: 'shell', ok: exitCode === 0, resultDigest: `s${exitCode}`, ...(exitCode === undefined ? {} : { exitCode }) })

  test('inert unless the setting is on (acceptance #4)', () => {
    const st = foldTurn(edit(emptyCompletionState), [])
    expect(evalAt(st, [])).toMatchObject({ allow: true, reason: null })
  })

  test('on: an edit with no later passing command blocks once, then releases forced-limit', () => {
    let st = foldTurn(edit(emptyCompletionState), [])
    const v = evalAt(st, [], on)
    expect(v).toMatchObject({ allow: false, rule: 'verify-after-edit', attempt: 1, openItems: 0 })
    st = foldTurn(foldBlocked(st, 'verify-after-edit'), [])
    expect(evalAt(st, [], on)).toMatchObject({ allow: true, reason: 'forced-limit' })
  })

  test('on: a shell call that exited 0 after the edit satisfies it; a failing or running one does not', () => {
    expect(evalAt(foldTurn(shell(edit(emptyCompletionState), 0), []), [], on)).toMatchObject({ allow: true, reason: null })
    expect(evalAt(foldTurn(shell(edit(emptyCompletionState), 1), []), [], on).allow).toBe(false)
    expect(evalAt(foldTurn(shell(edit(emptyCompletionState), undefined), []), [], on).allow).toBe(false)
  })

  test('on: an edit AFTER the passing command is unverified again', () => {
    const st = foldTurn(edit(shell(edit(emptyCompletionState), 0)), [])
    expect(evalAt(st, [], on).allow).toBe(false)
  })

  test('a failed edit is not an edit', () => {
    const st = foldTurn(foldToolResult(emptyCompletionState, { toolName: 'file.write', kind: 'file', ok: false, resultDigest: 'x' }), [])
    expect(evalAt(st, [], on).allow).toBe(true)
  })

  test('Rule 1 takes precedence: one reason per blocked turn', () => {
    const st = foldTurn(edit(emptyCompletionState), open2)
    expect(evalAt(st, open2, on)).toMatchObject({ allow: false, rule: 'open-plan' })
  })
})

test('the evaluator is pure: the state and the plan are not mutated', () => {
  const plan = structuredClone(open2)
  const st = foldTurn(emptyCompletionState, plan)
  const before = { ...st, seenResults: [...st.seenResults] }
  evalAt(st, plan)
  expect({ ...st, seenResults: [...st.seenResults] }).toEqual(before)
  expect(plan).toEqual(open2)
})
