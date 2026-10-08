import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { CONTEXT_CLOSE, CONTEXT_OPEN, contextBlock, contextText, splitContextBlock } from './agentistics-context'
import { SPAWN_SPECS, planSpawn } from './spawn-spec'

const ctx = (lang: 'pt' | 'en' = 'pt', task = false) => {
  const i = { lang, sessionId: 'abc123', ...(task ? { taskId: 'T-1', taskTitle: 'Corrigir login' } : {}) }
  return { text: contextText(i), block: contextBlock(i), dir: '/data/session-context/abc123' }
}

describe('context text', () => {
  test('stays within 25 lines, both languages, with and without a task', () => {
    for (const lang of ['pt', 'en'] as const) for (const task of [false, true]) {
      expect(contextText({ lang, sessionId: 's', ...(task ? { taskId: 'T', taskTitle: 'x' } : {}) }).split('\n').length).toBeLessThanOrEqual(25)
    }
  })
  test('names the session, the vault and the reserved ports; the task only when there is one', () => {
    const t = ctx('pt').text
    expect(t).toContain('abc123'); expect(t).toContain('vault://'); expect(t).toContain('47291')
    expect(t).not.toContain('agentistics_task_comment')
    expect(ctx('pt', true).text).toContain('agentistics_task_comment')
    expect(ctx('en', true).text).toContain('T-1')
  })
  test('the fenced block round-trips', () => {
    const c = ctx('en')
    expect(c.block.startsWith(CONTEXT_OPEN)).toBe(true); expect(c.block.endsWith(CONTEXT_CLOSE)).toBe(true)
    expect(splitContextBlock(`${c.block}\n\nhello`)).toEqual({ block: c.block, rest: 'hello' })
    expect(splitContextBlock('hello')).toBeNull()
  })
})

describe('delivery per harness', () => {
  const plan = (harness: (typeof HARNESS_ORDER)[number], over: object = {}) =>
    planSpawn({ harness, cwd: '/w', prompt: 'oi', context: ctx(), ...over })

  test('claude: --append-system-prompt, prompt untouched', () => {
    const r = plan('claude'); if (!r.ok) throw new Error('x')
    const i = r.plan.argv.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThan(0); expect(r.plan.argv[i + 1]).toBe(ctx().text)
    expect(r.plan.argv.at(-1)).toBe('oi'); expect(r.plan.contextVia).toBe('args')
  })
  test('codex: -c developer_instructions as a TOML string', () => {
    const r = plan('codex'); if (!r.ok) throw new Error('x')
    const i = r.plan.argv.indexOf('-c')
    expect(r.plan.argv[i + 1]).toBe(`developer_instructions=${JSON.stringify(ctx().text)}`)
    expect(r.plan.argv.at(-1)).toBe('oi')
  })
  test('copilot: env dir + AGENTS.md file, prompt typed untouched', () => {
    const r = plan('copilot'); if (!r.ok) throw new Error('x')
    expect(r.plan.env).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/data/session-context/abc123' })
    expect(r.plan.contextFile).toEqual({ dir: '/data/session-context/abc123', name: 'AGENTS.md', text: ctx().text })
    expect(r.plan.initialPrompt).toEqual({ mode: 'type', text: 'oi' })
  })
  test('gemini (flag), antigravity (flag), kimi (typed): block prepended to the first message', () => {
    for (const h of ['gemini', 'antigravity', 'kimi'] as const) {
      const r = plan(h); if (!r.ok) throw new Error(h)
      expect(r.plan.contextVia).toBe('first-message')
      const sent = r.plan.initialPrompt?.text ?? r.plan.argv.at(-1)!
      expect(sent).toBe(`${ctx().block}\n\noi`)
    }
  })
  test('no prompt on a fallback harness: nothing is invented', () => {
    const r = plan('gemini', { prompt: undefined }); if (!r.ok) throw new Error('x')
    expect(r.plan.contextVia).toBe('none'); expect(r.plan.argv).toEqual(['gemini'])
  })
  test('a resume carries no context at all', () => {
    for (const h of HARNESS_ORDER) {
      if (!SPAWN_SPECS[h]?.resume) continue
      const r = plan(h, { resumeId: 'x', prompt: undefined }); if (!r.ok) throw new Error(h)
      expect(r.plan.contextVia).toBeUndefined(); expect(r.plan.env).toBeUndefined()
    }
  })
  test('no context requested = argv identical to before', () => {
    for (const h of HARNESS_ORDER) {
      if (!SPAWN_SPECS[h]) continue
      const a = planSpawn({ harness: h, cwd: '/w', prompt: 'oi' }); if (!a.ok) throw new Error(h)
      expect(a.plan.contextVia).toBeUndefined(); expect(a.plan.env).toBeUndefined()
    }
  })
  test('every spawnable harness has a stated channel or the fallback', () => {
    for (const h of HARNESS_ORDER) {
      if (!SPAWN_SPECS[h]) continue
      const r = plan(h); if (!r.ok) throw new Error(h)
      expect(['args', 'env-dir', 'first-message']).toContain(r.plan.contextVia!)
    }
  })
})
