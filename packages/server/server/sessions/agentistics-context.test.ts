import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  CONTEXT_CLOSE, CONTEXT_HEADER, CONTEXT_LABEL, CONTEXT_OPEN, CONTEXT_SENT_NOTE, contextBlock, contextText, splitContextBlock, stripContextTurns,
  type ContextInput,
} from './agentistics-context'
import { SPAWN_SPECS, planSpawn } from './spawn-spec'
import { pendingContextFor } from './spawn-context'

const base = { sessionId: 'abc123', cwd: '/w/proj' }
const ctx = (over: Partial<ContextInput> = {}) => {
  const i: ContextInput = { ...base, ...over }
  return { text: contextText(i), block: contextBlock(i), dir: '/data/session-context/abc123' }
}

describe('context text', () => {
  test('header is the FIRST line, in the text and in the fenced block', () => {
    expect(contextText(base).split('\n')[0]).toBe(CONTEXT_HEADER)
    expect(contextBlock(base).split('\n').slice(0, 2)).toEqual([CONTEXT_OPEN, CONTEXT_HEADER])
    expect(CONTEXT_HEADER).toContain('not a message from the user')
  })
  test('names session, folder, the three tool groups and the rules', () => {
    const t = contextText(base)
    for (const w of ['abc123', '/w/proj', 'agentistics_task_comment', 'agentistics_session_group_edit', 'agentistics_harnesses', 'vault://', '47291', 'agentop upgrade', 'tunnels', 'SUGGEST', 'Clean up after yourself', 'git worktree remove', 'agentop session kill', 'Ask before removing anything you did not create']) expect(t).toContain(w)
    expect(t).toContain('outside /w/proj')
  })
  test('no task: says so and offers to file it; with task: names it, never done before validation', () => {
    expect(contextText(base)).toContain('not linked to a task')
    expect(contextText(base)).not.toContain('belongs to Agentask task')
    const t = contextText({ ...base, taskId: 'T-1', taskTitle: 'Fix login' })
    expect(t).toContain('belongs to Agentask task T-1 "Fix login".')
    expect(t).toContain('never mark it done before the user validates')
    expect(t).not.toContain('not linked to a task')
  })
  test('subtask is named only when present', () => {
    const t = contextText({ ...base, taskId: 'T-1', taskTitle: 'Fix login', subtaskId: 'S-9', subtaskTitle: 'Add test' })
    expect(t).toContain('task T-1 "Fix login", subtask S-9 "Add test".')
    expect(contextText({ ...base, taskId: 'T-1', taskTitle: 'x' })).not.toContain(', subtask ')
  })
  test('harness list: printed when known, omitted when absent or empty', () => {
    expect(contextText({ ...base, harnesses: ['Claude Code', 'Codex'] })).toContain('Harnesses installed on this machine: Claude Code, Codex.')
    expect(contextText(base)).not.toContain('Harnesses installed')
    expect(contextText({ ...base, harnesses: [] })).not.toContain('Harnesses installed')
  })
  test('the fenced block round-trips', () => {
    const c = ctx()
    expect(c.block.startsWith(CONTEXT_OPEN)).toBe(true); expect(c.block.endsWith(CONTEXT_CLOSE)).toBe(true)
    expect(splitContextBlock(`${c.block}\n\nhello`)).toEqual({ block: c.block, rest: 'hello' })
    expect(splitContextBlock('hello')).toBeNull()
  })
  test('the UI label stays PT/EN', () => {
    expect(CONTEXT_LABEL.pt).toBe('contexto do agentistics'); expect(CONTEXT_LABEL.en).toBe('agentistics context')
  })
})

describe('chat stripping', () => {
  const turn = (text: string, extra: object = {}) => ({ role: 'user', text, ...extra })
  test('fenced block + text: the bubble keeps only what was typed, preceded by ONE chip', () => {
    const out = stripContextTurns([turn(`${ctx().block}\n\nfix the bug`)])
    expect(out).toEqual([turn('', { system: CONTEXT_SENT_NOTE }), turn('fix the bug')])
    expect(JSON.stringify(out)).not.toContain(CONTEXT_OPEN)
  })
  test('block alone: chip only, no empty bubble', () => {
    expect(stripContextTurns([turn(ctx().block)])).toEqual([turn('', { system: CONTEXT_SENT_NOTE })])
  })
  test('other turns are untouched, including an assistant quoting the fence', () => {
    const a = { role: 'assistant', text: `${CONTEXT_OPEN}x${CONTEXT_CLOSE}` }
    const u = turn('hello')
    expect(stripContextTurns([u, a])).toEqual([u, a])
  })
  test('the chip has a PT/EN explanation in the notes table', async () => {
    const { CHAT_NOTES } = await import('../../../web/src/lib/chatNote')
    expect(CHAT_NOTES[CONTEXT_SENT_NOTE]!.pt).toBe('contexto do agentistics enviado')
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
  test('kimi: invisible — --agent-file whose body keeps the default prompt and appends the context; the typed prompt is untouched', () => {
    const r = plan('kimi'); if (!r.ok) throw new Error('x')
    expect(r.plan.contextVia).toBe('files')
    expect(r.plan.argv).toContain('--agent-file')
    expect(r.plan.argv[r.plan.argv.indexOf('--agent-file') + 1]).toBe('/data/session-context/abc123/agentistics-agent.md')
    const f = r.plan.contextFile!
    expect(f.text.startsWith('---\nname: agentistics-session\ndescription: ')).toBe(true)
    expect(f.text).toContain('---\n${base_prompt}\n\n' + CONTEXT_HEADER)
    expect(r.plan.initialPrompt).toEqual({ mode: 'type', text: 'oi' })
  })
  test('antigravity and gemini (no invisible channel exists): fenced block, header first, user text AFTER the closing fence', () => {
    for (const h of ['antigravity', 'gemini'] as const) {
      const r = plan(h); if (!r.ok) throw new Error('x')
      expect(r.plan.contextVia).toBe('first-message')
      const sent = r.plan.initialPrompt?.text ?? r.plan.argv.at(-1)!
      expect(sent).toBe(`${ctx().block}\n\noi`)
      expect(sent.split('\n')[1]).toBe(CONTEXT_HEADER)
      expect(sent.indexOf('oi')).toBeGreaterThan(sent.indexOf(CONTEXT_CLOSE))
    }
  })
  test('no first message: NOTHING is sent (context is held, never sent alone)', () => {
    for (const h of ['antigravity', 'gemini'] as const) {
      const r = plan(h, { prompt: undefined }); if (!r.ok) throw new Error('x')
      expect(r.plan.contextVia).toBe('none'); expect(r.plan.initialPrompt).toBeUndefined()
      expect(r.plan.argv.join(' ')).not.toContain(CONTEXT_OPEN)
      expect(pendingContextFor(r.plan, ctx())).toBe(ctx().block)
    }
    const g = plan('claude', { prompt: undefined }); if (!g.ok) throw new Error('x')
    expect(pendingContextFor(g.plan, ctx())).toBeUndefined()
  })
  test('every channel but the fallback keeps the context out of the prompt', () => {
    for (const h of ['claude', 'codex', 'copilot', 'kimi'] as const) {
      const r = plan(h); if (!r.ok) throw new Error(h)
      const sent = r.plan.initialPrompt?.text ?? r.plan.argv.at(-1)!
      expect(sent).toBe('oi')
    }
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
      expect(['args', 'env-dir', 'files', 'first-message']).toContain(r.plan.contextVia!)
    }
  })
})
