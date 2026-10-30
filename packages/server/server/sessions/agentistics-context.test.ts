import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  CONTEXT_CLOSE, CONTEXT_HEADER, CONTEXT_LABEL, CONTEXT_OPEN, CONTEXT_SENT_NOTE, contextBlock, contextText, splitContextBlock, stripContextTurns,
  type ContextInput,
} from './agentistics-context'
import { SPAWN_SPECS, planSpawn } from './spawn-spec'
import { pendingContextFor } from './spawn-context'
import { CONTEXT_TOOL_NAMES, METRICS_DASHBOARDS_LINE, flowLines } from './agentistics-context'
import { briefingSkills } from '../briefing'
import { clearSpecificationSkillCache, specificationSkillsFor } from './specification-skills'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  test('names session, folder, the tool groups and the rules', () => {
    const t = contextText(base)
    for (const w of ['abc123', '/w/proj', 'agentistics_task_comment', 'agentistics_session_group_edit', 'vault://', '47291', 'agentop upgrade', 'tunnels', 'SUGGEST', 'Clean up after yourself', 'git worktree remove', 'agentop session kill', 'Ask before removing anything you did not create']) expect(t).toContain(w)
    expect(t).toContain('outside /w/proj')
  })
  test('role guidance, session opening, model balance, isolated tests, and milestone commits are explicit', () => {
    const t = contextText(base)
    for (const w of ['Your role here: decide from the request', 'LEADER organises', 'WORKER implements one defined piece', 'AUTO:', 'Becoming leader:', '[ LEADER ]', '[ LÍDER ]', 'agentop session <harness>', 'agentop session batch', 'QA must use a different model', 'ASK the user', 'never make it automatic', 'agentop run --rm -- <command>', 'Commit at every green milestone', 'with no brief, ASK the user whether to use a specification skill', 'pass the specification path or text in the worker prompt', 'never asks about specification skills', 'No usage rules are saved yet:', 'agentop session <harness> --handoff', 'real harness in a terminal', '"Terminal" tab', 'OAuth login of an MCP via `/mcp`', 'login prompt', 'TUI menu', 'type `/mcp`', 'pick the server', 'Authenticate', 'browser opens for the login', 'Never say the session is not interactive', 'never send the user to an outside terminal']) expect(t).toContain(w)
    expect(t).not.toContain('Use superpowers')
  })
  test('model-facing context contains no internal TODO or phase notes', () => {
    const t = contextText(base)
    expect(t).not.toContain('TODO')
    expect(t).not.toContain('Phase 2')
  })
  test('the context lists every registered MCP tool', () => {
    // Read from the source: importing agentistics-mcp.ts starts the stdio server and ends the test process.
    const source = readFileSync(join(import.meta.dir, '../../../mcp/agentistics-mcp.ts'), 'utf8')
    const registered = [...source.matchAll(/^\s*name: "(agentistics_[a-z_]+)",$/gm)].map(m => m[1] as string)
    expect(registered.length).toBeGreaterThan(30)
    expect(new Set<string>(CONTEXT_TOOL_NAMES)).toEqual(new Set<string>(registered))
  })
  test('the briefing names the SESSIONS and AGENTASK tools, and only mentions metrics/dashboards in one line', () => {
    const t = contextText(base)
    for (const n of CONTEXT_TOOL_NAMES) {
      const listed = t.includes(n)
      const sessionsOrTasks = /^agentistics_(task|session|checkin)/.test(n)
      if (sessionsOrTasks) expect(listed).toBe(true)
      else expect(listed).toBe(false)
    }
    expect(t).toContain(METRICS_DASHBOARDS_LINE)
    expect(t).toMatch(/metrics and dashboard/)
  })
  test('specification skills are printed only when detected', () => {
    const t = contextText({ ...base, specSkills: ['superpowers'] })
    expect(t).toContain('Specification skills installed for this harness: superpowers')
    expect(contextText(base)).not.toContain('Specification skills installed')
  })
  test('briefing follows the UI language and only emits plan limits when the tool is present', () => {
    expect(contextText({ ...base, lang: 'pt' })).toContain('Ambiente operacional')
    expect(contextText({ ...base, lang: 'pt' })).toContain('segredos')
    expect(contextText(base)).not.toContain('agentistics_plan_limits')
    expect(contextText({ ...base, toolNames: ['agentistics_plan_limits'] })).toContain('agentistics_plan_limits')
  })
  test('no task: says so and offers to file it; with task: names it, never done before validation', () => {
    expect(contextText(base)).toContain('not linked to a task')
    expect(contextText(base)).not.toContain('belongs to Agentask task')
    const t = contextText({ ...base, taskId: 'T-1', taskTitle: 'Fix login' })
    expect(t).toContain('belongs to Agentask task T-1 "Fix login".')
    expect(t).toContain('never mark it done before the user validates')
    expect(t).not.toContain('not linked to a task')
  })
  test('a filed session gets the board lifecycle; an unfiled one does not', () => {
    expect(contextText({ ...base, taskId: 'T-1' })).toContain('Board lifecycle:')
    expect(contextText({ ...base, taskId: 'T-1' })).toContain('kind=handback')
    expect(contextText(base)).not.toContain('Board lifecycle:')
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

describe('specification skill detection', () => {
  test('reads Claude superpowers from a fake plugin registry and caches by mtime', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-spec-skills-'))
    try {
      const file = join(home, '.claude/plugins/installed_plugins.json')
      mkdirSync(join(home, '.claude/plugins'), { recursive: true })
      writeFileSync(file, JSON.stringify({ plugins: { 'superpowers@local': [{ installPath: '/fake' }] } }))
      clearSpecificationSkillCache()
      expect(specificationSkillsFor('claude', home)).toEqual(['superpowers'])
      writeFileSync(file, JSON.stringify({ plugins: { 'other@local': [] } }))
      utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000))
      expect(specificationSkillsFor('claude', home)).toEqual([])
      expect(specificationSkillsFor('gemini', home)).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }); clearSpecificationSkillCache() }
  })
  test('reads fake skill directories for a harness with a known location', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-spec-skills-'))
    try {
      mkdirSync(join(home, '.codex/skills/spec-a'), { recursive: true })
      writeFileSync(join(home, '.codex/skills/spec-a/SKILL.md'), '# a')
      mkdirSync(join(home, '.codex/skills/not-a-skill'), { recursive: true })
      clearSpecificationSkillCache()
      expect(specificationSkillsFor('codex', home)).toEqual(['spec-a'])
      expect(specificationSkillsFor('unknown', home)).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }); clearSpecificationSkillCache() }
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
  test('antigravity, gemini and kimi (no invisible channel exists — kimi 2.1.1\'s interactive TUI drops --agent-file): fenced block, header first, user text AFTER the closing fence', () => {
    for (const h of ['antigravity', 'gemini', 'kimi'] as const) {
      const r = plan(h); if (!r.ok) throw new Error('x')
      expect(r.plan.contextVia).toBe('first-message')
      const sent = r.plan.initialPrompt?.text ?? r.plan.argv.at(-1)!
      expect(sent).toBe(`${ctx().block}\n\noi`)
      expect(sent.split('\n')[1]).toBe(CONTEXT_HEADER)
      expect(sent.indexOf('oi')).toBeGreaterThan(sent.indexOf(CONTEXT_CLOSE))
    }
  })
  test('no first message: NOTHING is sent (context is held, never sent alone)', () => {
    for (const h of ['antigravity', 'gemini', 'kimi'] as const) {
      const r = plan(h, { prompt: undefined }); if (!r.ok) throw new Error('x')
      expect(r.plan.contextVia).toBe('none'); expect(r.plan.initialPrompt).toBeUndefined()
      expect(r.plan.argv.join(' ')).not.toContain(CONTEXT_OPEN)
      expect(pendingContextFor(r.plan, ctx())).toBe(ctx().block)
    }
    const g = plan('claude', { prompt: undefined }); if (!g.ok) throw new Error('x')
    expect(pendingContextFor(g.plan, ctx())).toBeUndefined()
  })
  test('every channel but the fallback keeps the context out of the prompt', () => {
    for (const h of ['claude', 'codex', 'copilot'] as const) {
      const r = plan(h); if (!r.ok) throw new Error(h)
      const sent = r.plan.initialPrompt?.text ?? r.plan.argv.at(-1)!
      expect(sent).toBe('oi')
    }
  })
  test('a resume carries no context at all', () => {
    for (const h of HARNESS_ORDER) {
      if (!SPAWN_SPECS[h]?.resume) continue
      const r = plan(h, { resumeId: '04d97770-e53f-4b7d-86d2-63bd12ec32eb', prompt: undefined }); if (!r.ok) throw new Error(h)
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

describe('context for a child session', () => {
  test('a started session is told its parent and how to report to it', () => {
    const t = contextText({ sessionId: 'c1', cwd: '/w', parentId: 'p1', parentTitle: 'Leader' })
    expect(t).toContain('You were started by session p1 ("Leader")')
    expect(t).toContain('agentistics_session_message (kind: handback | block | question)')
    expect(t).toContain('not to the user')
  })
  test('no parent: no such sentence; unknown title still names the id', () => {
    expect(contextText({ sessionId: 'c1', cwd: '/w' })).not.toContain('You were started by')
    const t = contextText({ sessionId: 'c1', cwd: '/w', parentId: 'p1' })
    expect(t).toContain('You were started by session p1. When you finish')
  })
  test('the cleanup rule is ONE bullet and still covers closing children and removing worktrees', () => {
    const t = contextText({ sessionId: 'c1', cwd: '/w' })
    expect(t.match(/Clean up after yourself/g)?.length).toBe(1)
    expect(t).toContain('so it is filed in the task\'s finished folder')
    expect(t).toContain('git worktree remove')
  })
})

describe('role line follows the stored role', () => {
  const base = { sessionId: 's1', cwd: '/w' }
  test('no stored role: decide from the request', () => {
    expect(contextText(base)).toContain('Your role here: decide from the request')
  })
  test('leader and worker print their own line instead', () => {
    const l = contextText({ ...base, role: 'leader' })
    expect(l).toContain('Your role here: LEADER.')
    expect(l).not.toContain('decide from the request')
    const w = contextText({ ...base, role: 'worker' })
    expect(w).toContain('Your role here: WORKER.')
    expect(w).not.toContain('decide from the request')
  })
  test('only the AUTO briefing asks to record the worker decision', () => {
    const marker = 'decide leader or worker from the request and call agentistics_session_role'
    expect(contextText(base)).toContain(marker)
    expect(contextText({ ...base, role: 'leader' })).not.toContain(marker)
    expect(contextText({ ...base, role: 'worker' })).not.toContain(marker)
    expect(contextText({ ...base, role: 'leader' })).toContain('Becoming leader: call agentistics_session_role with role "leader"')
  })
  test('the leader briefing points at agentistics_session_role', () => {
    expect(contextText(base)).toContain('agentistics_session_role')
  })
})

describe('folders in the briefing', () => {
  test('the open and clean-up lines name --folder', () => {
    const t = contextText(base)
    expect(t).toContain('--folder "<folder>"')
    expect(t).toContain('agentop session kill <id> --folder "<finished folder>"')
  })
  test('a briefed session in a folder gets its path and siblings; otherwise no line', () => {
    expect(contextText({ ...base, folder: { path: 'Eng/Leaders', siblings: ['Eng/Workers'] } })).toContain('Your sidebar folder: Eng/Leaders. Sibling folders: Eng/Workers.')
    expect(contextText(base)).not.toContain('Your sidebar folder')
  })
})

describe('away mode in the briefing', () => {
  const NOW = Date.parse('2026-10-12T03:00:00.000Z')
  const away = { on: true, since: '2026-10-12T02:00:00.000Z', until: '2026-10-12T12:00:00.000Z', authorised: ['releases' as const], maxWorkers: 6, topCaps: {} }
  test('absent, off or expired: no line', () => {
    expect(contextText({ ...base, now: NOW })).not.toContain('AWAY MODE')
    expect(contextText({ ...base, now: NOW, away: { ...away, on: false } })).not.toContain('AWAY MODE')
    expect(contextText({ ...base, now: Date.parse('2026-10-12T13:00:00Z'), away })).not.toContain('AWAY MODE')
  })
  test('leader gets the decide-and-record line right after the role line', () => {
    const lines = contextText({ ...base, now: NOW, away, role: 'leader' }).split('\n')
    const i = lines.findIndex(l => l.startsWith('AWAY MODE'))
    expect(i).toBeGreaterThan(0)
    expect(lines[i - 1]).toContain('LEADER')
    expect(lines[i]).toContain('until 2026-10-12T12:00:00.000Z')
    expect(lines[i]).toContain('publish releases the leader has approved')
    expect(lines.slice(i, i + 4).join('\n')).toContain('never end a turn on a question to the owner')
  })
  test('on: pacing points at the plan-limits line already in the briefing (said once); off: every away line is gone', () => {
    const tools = [...CONTEXT_TOOL_NAMES]
    const onText = contextText({ ...base, now: NOW, away, role: 'leader', toolNames: tools })
    expect(onText).toContain('Away pacing')
    expect(onText).toContain('apply the agentistics_plan_limits rule above')
    expect(onText.match(/5-hour window is at least 85%/g)).toHaveLength(1)
    const offText = contextText({ ...base, now: NOW, away: { ...away, on: false }, role: 'leader', toolNames: tools })
    for (const w of ['AWAY MODE', 'Away pacing', 'Away quality', 'Away communication']) expect(offText).not.toContain(w)
    expect(offText.match(/5-hour window is at least 85%/g)).toHaveLength(1)
  })
  test('worker is told to report to its leader, not the owner', () => {
    const t = contextText({ ...base, now: NOW, away, role: 'worker', parentId: 'p1' })
    expect(t).toContain('Do not ask the owner anything')
  })
})

describe('start flow (any project, any harness)', () => {
  const other = { sessionId: 's9', cwd: '/home/u/some-other-project' }
  const spawnable = HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)
  test('at least the six CLIs are spawnable (opencode has no spawn spec)', () => {
    expect(spawnable.length).toBeGreaterThanOrEqual(6)
  })
  for (const harness of spawnable) {
    test(`${harness}: spawn is ok and the full numbered flow reaches the instruction channel`, () => {
      const c = contextText(other)
      const r = planSpawn({ harness, cwd: other.cwd, prompt: 'oi', context: { text: c, block: contextBlock(other), dir: '/d' } })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const plan = r.plan as { argv: string[]; env?: Record<string, string>; contextFile?: { dir: string; name: string; text: string }; contextExtraFiles?: { name: string; text: string }[]; contextVia?: string; initialPrompt?: { mode: string; text?: string } }
      const spec = SPAWN_SPECS[harness]!
      // Select the harness's REAL channel and assert the full flow arrives through it.
      let channel: string
      switch (plan.contextVia) {
        case 'args': {
          expect(spec.context?.kind).toBe('args')
          channel = plan.argv.join('\n')
          break
        }
        case 'env-dir': {
          expect(spec.context?.kind).toBe('env-dir')
          const e = spec.context as { env: string; file: string }
          expect(plan.env?.[e.env]).toBe(plan.contextFile!.dir)
          expect(plan.contextFile!.name).toBe(e.file)
          channel = plan.contextFile!.text
          break
        }
        case 'files': {
          expect(plan.contextFile).toBeDefined()
          channel = [plan.contextFile!.text, ...(plan.contextExtraFiles ?? []).map(f => f.text)].join('\n')
          break
        }
        case 'first-message': {
          // No official channel: the fenced block rides the first message (positional/flag argv or typed text).
          channel = [plan.initialPrompt?.text ?? '', ...plan.argv].join('\n')
          expect(channel).toContain(CONTEXT_OPEN)
          break
        }
        default:
          throw new Error(`${harness}: context not delivered (${String(plan.contextVia)})`)
      }
      for (const line of flowLines('en')) expect(channel.includes(line) || channel.includes(JSON.stringify(line).slice(1, -1))).toBe(true)
    })
  }
  test('auto: role step first (leader check BEFORE registering), steps numbered 1..4', () => {
    const lines = flowLines('en')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toMatch(/^1\. Role: before taking any role, check agentistics_sessions for an existing leader.*exclude this session.*role worker.*otherwise decide/)
    for (let n = 1; n <= 4; n++) expect(lines[n]).toMatch(new RegExp(`^${n}\\. `))
    expect(contextText(other)).toContain(lines[4]!)
  })
  test('leader: no auto role step, downgrade is explicit', () => {
    const t = flowLines('en', 'leader').join('\n')
    expect(t).not.toContain('Role:')
    expect(t).toContain('1. One leader')
    expect(t).toContain('exclude this session')
    expect(t).toContain('role worker')
  })
  test('worker: no Role step, no leader check', () => {
    const t = flowLines('en', 'worker').join('\n')
    expect(t).not.toContain('Role:')
    expect(t).not.toContain('One leader')
    expect(t).toContain('1. Task: find or create')
  })
  test('task step: find-or-create then link unconditionally; linked variant', () => {
    expect(flowLines('en', 'worker').join('\n')).toContain('find or create the task')
    expect(flowLines('en', 'worker').join('\n')).toContain(', then link this session with agentistics_task_session')
    const linked = flowLines('en', 'worker', true).join('\n')
    expect(linked).toContain('already linked')
    expect(linked).not.toContain('agentistics_task_create')
  })
  test('lifecycle: in_progress at start, comments at milestones, in_review on delivery; no-parent comment', () => {
    const t = flowLines('en').join('\n')
    expect(t).toContain('set in_progress when you start')
    expect(t).toContain('set in_review on delivery')
    expect(t).toContain('with no parent, a comment on the task')
    expect(t).not.toContain('in_progress → in_review')
  })
  test('pt: roles and linked variant', () => {
    const auto = flowLines('pt').join('\n')
    expect(auto).toContain('Fluxo (siga em ordem')
    expect(auto).toContain('1. Papel: antes de assumir qualquer papel')
    expect(auto).toContain('role worker')
    expect(flowLines('pt', 'leader').join('\n')).toContain('1. Líder único')
    const w = flowLines('pt', 'worker', true).join('\n')
    expect(w).not.toContain('Papel:')
    expect(w).toContain('já está vinculada')
    expect(w).toContain('ao entregar, in_review')
    expect(w).toContain('sem pai, um comentário na tarefa')
  })
  test('no duplicate role registration prose; lifecycle line stays consistent', () => {
    const t = contextText({ ...other, taskId: 'T-1' })
    expect(t).not.toContain('If you have no stored role (AUTO)')
    expect(t).toContain('Board lifecycle:')
  })
  test('added flow stays bounded in every variant', () => {
    for (const lang of ['en', 'pt'] as const) for (const role of [undefined, 'leader', 'worker'] as const) for (const task of [false, true]) {
      expect(flowLines(lang, role, task).join('\n').length).toBeLessThan(1500)
    }
  })
  test('installed briefing carries the flow in en+pt from the same source', () => {
    const skill = briefingSkills().find(s => s.name === 'agentistics-session-flow')!
    expect(skill.body).toContain(flowLines('en').join('\n'))
    expect(skill.body).toContain(flowLines('pt').join('\n'))
    expect(skill.body.length).toBeLessThan(3500)
  })
})
