import { describe, expect, test } from 'bun:test'
import {
  allSwitchOptions, claudeProjectDir, crossSwitchPrompt, decideCrossSwitch, decideSwitch, detectLimitInTail, planSwitchCopies,
  switchMessage, switchOptions, switchSupported, SWITCH_LAYOUT, unavailableSwitchTargets,
} from './account-switch'
import type { SpawnAccountContext, SpawnAccountRow } from './spawn-account'
import { HARNESS_ORDER } from '@agentistics/core'

const row = (o: Partial<SpawnAccountRow> & { id: string }): SpawnAccountRow => ({
  harness: 'claude', root: null, bound: true, available: true, firstSeen: 1, ...o,
})
const ctx = (accounts: SpawnAccountRow[], picks?: SpawnAccountContext['picks']): SpawnAccountContext => ({
  enabled: true, accounts, ...(picks ? { picks } : {}),
})
const two = [row({ id: 'acc_a', root: null }), row({ id: 'acc_b', root: '/r/b', firstSeen: 2 })]

describe('planSwitchCopies', () => {
  test('claude: transcript and sidecar land under the target root, keyed on the resume cwd', () => {
    const copies = planSwitchCopies({
      harness: 'claude', conversationId: 'c1', cwd: '/home/u/my_proj', sourceRoot: '/home/u/.claude', targetRoot: '/r/b',
      files: { transcript: '/home/u/.claude/projects/-old-slug/c1.jsonl', sidecar: '/home/u/.claude/projects/-old-slug/c1' },
    })
    expect(copies).toEqual([
      { from: '/home/u/.claude/projects/-old-slug/c1.jsonl', to: '/r/b/projects/-home-u-my-proj/c1.jsonl', kind: 'file' },
      { from: '/home/u/.claude/projects/-old-slug/c1', to: '/r/b/projects/-home-u-my-proj/c1', kind: 'dir' },
    ])
  })
  test('claude: no sidecar, one copy', () => {
    const copies = planSwitchCopies({ harness: 'claude', conversationId: 'c1', cwd: '/w', sourceRoot: '/a', targetRoot: '/b', files: { transcript: '/a/projects/-w/c1.jsonl' } })
    expect(copies).toEqual([{ from: '/a/projects/-w/c1.jsonl', to: '/b/projects/-w/c1.jsonl', kind: 'file' }])
  })
  test('codex: the rollout keeps its dated path under the target CODEX_HOME', () => {
    const copies = planSwitchCopies({
      harness: 'codex', conversationId: '019a', cwd: '/w', sourceRoot: '/h/.codex', targetRoot: '/r/codex2',
      files: { transcript: '/h/.codex/sessions/2026/10/24/rollout-2026-10-24T10-00-00-019a.jsonl' },
    })
    expect(copies).toEqual([{ from: '/h/.codex/sessions/2026/10/24/rollout-2026-10-24T10-00-00-019a.jsonl', to: '/r/codex2/sessions/2026/10/24/rollout-2026-10-24T10-00-00-019a.jsonl', kind: 'file' }])
  })
  test('codex: a rollout outside its root, or of another conversation, is refused', () => {
    expect(planSwitchCopies({ harness: 'codex', conversationId: '019a', cwd: '/w', sourceRoot: '/h/.codex', targetRoot: '/r', files: { transcript: '/elsewhere/rollout-x-019a.jsonl' } })).toBeNull()
    expect(planSwitchCopies({ harness: 'codex', conversationId: '019a', cwd: '/w', sourceRoot: '/h/.codex', targetRoot: '/r', files: { transcript: '/h/.codex/sessions/2026/10/24/rollout-x-zzz.jsonl' } })).toBeNull()
  })
  test('no transcript on disk, nothing to carry', () => {
    expect(planSwitchCopies({ harness: 'claude', conversationId: 'c', cwd: '/w', sourceRoot: '/a', targetRoot: '/b', files: {} })).toBeNull()
  })
  test('never plans a copy for a harness with no layout', () => {
    for (const h of HARNESS_ORDER) {
      if (SWITCH_LAYOUT[h]) continue
      expect(switchSupported(h)).toBe(false)
      expect(planSwitchCopies({ harness: h, conversationId: 'c', cwd: '/w', sourceRoot: '/a', targetRoot: '/b', files: { transcript: '/a/c.jsonl' } })).toBeNull()
    }
  })
  test('slug matches Claude Code (every non-alphanumeric becomes -)', () => {
    expect(claudeProjectDir('/home/u/my_proj x.y')).toBe('-home-u-my-proj-x-y')
  })
})

describe('decideSwitch', () => {
  const base = { harness: 'claude' as const, conversationId: 'c1', running: true, agentCaller: false }
  test('moves a default-root session to a secondary account', () => {
    const d = decideSwitch({ ...base, currentAccountId: 'acc_a', requested: 'acc_b', context: ctx(two) })
    expect(d).toEqual({ ok: true, target: { id: 'acc_b', root: '/r/b' }, sourceRoot: null })
  })
  test('a row recorded before accounts runs on the default root\'s account', () => {
    const d = decideSwitch({ ...base, requested: 'acc_a', context: ctx(two) })
    expect(d).toMatchObject({ ok: false, reason: 'same_account' })
  })
  test('refusals, each in its own code, before anything is ended', () => {
    const c = ctx([...two, row({ id: 'acc_off', root: '/r/off', available: false }), row({ id: 'acc_gone', root: '/r/g', retired: true }),
      row({ id: 'acc_out', root: null, bound: false }), row({ id: 'acc_x', harness: 'codex', root: '/r/x' })])
    const r = (requested: string, extra: Partial<Parameters<typeof decideSwitch>[0]> = {}) =>
      decideSwitch({ ...base, currentAccountId: 'acc_a', requested, context: c, ...extra })
    expect(r('acc_a')).toMatchObject({ reason: 'same_account' })
    expect(r('acc_off')).toMatchObject({ reason: 'account_unavailable' })
    expect(r('acc_gone')).toMatchObject({ reason: 'account_retired' })
    expect(r('acc_out')).toMatchObject({ reason: 'account_signed_out' })
    expect(r('acc_x')).toMatchObject({ reason: 'unknown_account' }) // another harness's account
    expect(r('acc_nope')).toMatchObject({ reason: 'unknown_account' })
    expect(r('acc_b', { conversationId: undefined })).toMatchObject({ reason: 'no_conversation' })
    expect(r('acc_b', { harness: 'gemini' })).toMatchObject({ reason: 'switch_unsupported' })
    expect(decideSwitch({ ...base, requested: 'acc_b', context: { ...c, enabled: false } })).toMatchObject({ reason: 'accounts_disabled' })
  })
  test('the agent rule still holds: an agent cannot move work onto a hidden account', () => {
    const c = ctx([...two, row({ id: 'acc_h', root: '/r/h', available: false })])
    expect(decideSwitch({ ...base, currentAccountId: 'acc_a', requested: 'acc_h', agentCaller: true, context: c })).toMatchObject({ reason: 'account_unavailable' })
  })
})

describe('switchOptions', () => {
  test('lists the other usable accounts of the same harness, router pick first', () => {
    const c = ctx([...two, row({ id: 'acc_c', root: '/r/c', firstSeen: 3 }), row({ id: 'acc_off', root: '/r/o', available: false }),
      row({ id: 'acc_k', harness: 'codex', root: '/r/k' })], { claude: 'acc_c' })
    const out = switchOptions({ harness: 'claude', currentAccountId: 'acc_a', agentCaller: false, context: c, meta: [{ id: 'acc_b', label: 'b@x' }] })
    expect(out.map(o => o.id)).toEqual(['acc_c', 'acc_b'])
    expect(out[0]!.recommended).toBe(true)
    expect(out[1]!.label).toBe('b@x')
  })
  test('nothing with the flag off or on an unsupported harness', () => {
    expect(switchOptions({ harness: 'claude', agentCaller: false, context: { enabled: false, accounts: two }, meta: [] })).toEqual([])
    expect(switchOptions({ harness: 'gemini', agentCaller: false, context: ctx(two), meta: [] })).toEqual([])
  })
})

describe('detectLimitInTail', () => {
  const user = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } })
  const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })
  const reply = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
  // Shape measured on this machine's own transcripts, 2026-10-09.
  const claudeLimit = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1791398400, rateLimitType: 'five_hour' } },
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3:40pm" }] },
  })
  test('claude: the limit, its reset and the prompt it refused', () => {
    expect(detectLimitInTail('claude', [user('first'), reply('ok'), toolResult, user('fix the bug'), claudeLimit])).toEqual({
      resetsAt: 1791398400000, message: "You've hit your session limit · resets 3:40pm", pendingPrompt: 'fix the bug',
    })
  })
  test('claude: a real reply after the limit clears it', () => {
    expect(detectLimitInTail('claude', [user('a'), claudeLimit, user('b'), reply('done')])).toBeNull()
  })
  test('claude: a retry refused again keeps the newest prompt as the pending one', () => {
    expect(detectLimitInTail('claude', [user('a'), claudeLimit, user('b'), claudeLimit])?.pendingPrompt).toBe('b')
  })
  test('claude: a harness note is never the pending prompt', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>x' } })
    expect(detectLimitInTail('claude', [user('real'), meta, claudeLimit])?.pendingPrompt).toBe('real')
  })
  test('codex: task_complete with usage_limit_exceeded (shape measured 2026-10-08)', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'run the tests' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: 'You’ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } } }),
    ]
    expect(detectLimitInTail('codex', lines)).toEqual({ message: 'You’ve hit your usage limit.', pendingPrompt: 'run the tests' })
    expect(detectLimitInTail('codex', [...lines, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'ok' } })])).toBeNull()
  })
  test('garbage and other harnesses read as no limit', () => {
    expect(detectLimitInTail('claude', ['{not json', ''])).toBeNull()
    expect(detectLimitInTail('gemini', [claudeLimit])).toBeNull()
  })
})

describe('agentop session switch-account (parse)', () => {
  test('ref, account and --resend', async () => {
    const { parseSessionArgs } = await import('./cli-parse')
    expect(parseSessionArgs(['switch-account', 'abc', 'acc_b', '--resend'])).toEqual({ kind: 'switch-account', ref: 'abc', accountId: 'acc_b', resend: true })
    expect(parseSessionArgs(['switch-account', 'abc'])).toEqual({ kind: 'switch-account', ref: 'abc' })
    expect(parseSessionArgs(['switch-account'])).toMatchObject({ kind: 'error' })
  })
  test('--harness picks another harness, in any position; a bare --harness is a usage error', async () => {
    const { parseSessionArgs } = await import('./cli-parse')
    expect(parseSessionArgs(['switch-account', 'abc', 'acc_k', '--harness', 'codex'])).toEqual({ kind: 'switch-account', ref: 'abc', accountId: 'acc_k', harness: 'codex' })
    expect(parseSessionArgs(['switch-account', '--harness', 'gemini', 'abc'])).toEqual({ kind: 'switch-account', ref: 'abc', harness: 'gemini' })
    expect(parseSessionArgs(['switch-account', 'abc', '--harness'])).toMatchObject({ kind: 'error' })
  })
})

describe('allSwitchOptions (v2: every harness)', () => {
  const accounts = [
    ...two, row({ id: 'acc_c', root: '/r/c', firstSeen: 3 }),
    row({ id: 'acc_k1', harness: 'codex', root: null, firstSeen: 4 }), row({ id: 'acc_k2', harness: 'codex', root: '/r/k2', firstSeen: 5 }),
    row({ id: 'acc_g', harness: 'gemini', root: null, firstSeen: 6 }),
    row({ id: 'acc_gout', harness: 'gemini', root: '/r/g', bound: false }),
    row({ id: 'acc_kimi', harness: 'kimi', root: null }),
  ]
  const base = { harness: 'claude' as const, currentAccountId: 'acc_a', agentCaller: false, meta: [{ id: 'acc_g', label: 'g@x', plan: 'Pro' }] }
  test('own harness first (router pick first), then every startable harness grouped in order; signed-out and uninstalled absent', () => {
    const out = allSwitchOptions({ ...base, context: ctx(accounts, { claude: 'acc_c', codex: 'acc_k2' }), startable: ['claude', 'codex', 'gemini'] })
    expect(out.map(o => `${o.harness}:${o.id}`)).toEqual(['claude:acc_c', 'claude:acc_b', 'codex:acc_k2', 'codex:acc_k1', 'gemini:acc_g'])
    expect(out.filter(o => o.recommended).map(o => o.id)).toEqual(['acc_c', 'acc_k2'])
    expect(out.find(o => o.id === 'acc_g')).toMatchObject({ label: 'g@x', plan: 'Pro' })
    expect(out.some(o => o.id === 'acc_a')).toBe(false)
  })
  test('a harness that cannot carry its conversation still offers the OTHER harnesses', () => {
    const out = allSwitchOptions({ ...base, harness: 'gemini', currentAccountId: 'acc_g', context: ctx(accounts), startable: ['claude', 'codex', 'gemini'] })
    expect(out.map(o => o.harness)).toEqual(['claude', 'claude', 'claude', 'codex', 'codex'])
  })
  test('nothing with the flag off', () => {
    expect(allSwitchOptions({ ...base, context: { enabled: false, accounts }, startable: ['claude', 'codex'] })).toEqual([])
  })
})

describe('unavailableSwitchTargets (CONTA.LIMITES)', () => {
  const accounts = [
    ...two,
    row({ id: 'acc_hidden', root: '/r/h', available: false, firstSeen: 3 }),
    row({ id: 'acc_out', root: '/r/o', bound: false, firstSeen: 4 }),
    row({ id: 'acc_old', root: '/r/old', retired: true }),
    row({ id: 'acc_k', harness: 'codex', root: null, firstSeen: 5 }),
    row({ id: 'acc_kimi', harness: 'kimi', root: null, firstSeen: 6 }),
    row({ id: 'acc_cop', harness: 'copilot', root: null, firstSeen: 7 }),
  ]
  const base = { harness: 'claude' as const, currentAccountId: 'acc_a', meta: [{ id: 'acc_hidden', label: 'h@x', plan: 'Max' }] }
  test('every live account the options leave out, with the reason; current and retired never listed', () => {
    const startable = ['claude', 'codex'] as const
    const offered = allSwitchOptions({ ...base, agentCaller: false, context: ctx(accounts), startable })
    expect(offered.map(o => o.id)).toEqual(['acc_b', 'acc_k'])
    const out = unavailableSwitchTargets({ ...base, context: ctx(accounts), startable, offered })
    expect(out.map(o => `${o.id}:${o.reason}`)).toEqual(['acc_hidden:not_agentic', 'acc_out:signed_out', 'acc_kimi:harness_unavailable', 'acc_cop:harness_unavailable'])
    expect(out[0]).toMatchObject({ label: 'h@x', plan: 'Max', harness: 'claude' })
  })
  test('a session whose harness cannot carry its conversation: its own other accounts say so', () => {
    const own = [row({ id: 'acc_g1', harness: 'gemini' }), row({ id: 'acc_g2', harness: 'gemini', root: '/r/g2' })]
    const out = unavailableSwitchTargets({ harness: 'gemini', currentAccountId: 'acc_g1', meta: [], context: ctx(own), startable: ['gemini'], offered: [] })
    expect(out).toEqual([{ id: 'acc_g2', harness: 'gemini', label: 'acc_g2', reason: 'cant_carry' }])
  })
  test('nothing with the flag off', () => {
    expect(unavailableSwitchTargets({ ...base, context: { enabled: false, accounts }, startable: ['claude'], offered: [] })).toEqual([])
  })
})

describe('decideCrossSwitch', () => {
  const accounts = [...two, row({ id: 'acc_k', harness: 'codex', root: '/r/k' }), row({ id: 'acc_kout', harness: 'codex', root: '/r/x', bound: false })]
  const o = { harness: 'claude' as const, targetHarness: 'codex' as const, running: true, agentCaller: false, context: ctx(accounts), startable: ['claude', 'codex'] as const }
  test('an account of the target harness that a spawn would accept', () => {
    expect(decideCrossSwitch({ ...o, requested: 'acc_k', startable: [...o.startable] })).toEqual({ ok: true, target: { id: 'acc_k', root: '/r/k' } })
  })
  test('refusals: not installed, not running, signed out, another harness\'s account, flag off', () => {
    const st = [...o.startable]
    expect(decideCrossSwitch({ ...o, requested: 'acc_k', startable: ['claude'] })).toMatchObject({ ok: false, reason: 'harness_unavailable' })
    expect(decideCrossSwitch({ ...o, requested: 'acc_k', running: false, startable: st })).toMatchObject({ ok: false, reason: 'not_running_here' })
    expect(decideCrossSwitch({ ...o, requested: 'acc_kout', startable: st })).toMatchObject({ ok: false, reason: 'account_signed_out' })
    expect(decideCrossSwitch({ ...o, requested: 'acc_b', startable: st })).toMatchObject({ ok: false, reason: 'unknown_account' })
    expect(decideCrossSwitch({ ...o, requested: 'acc_k', context: { enabled: false, accounts }, startable: st })).toMatchObject({ ok: false, reason: 'accounts_disabled' })
    expect(switchMessage('harness_unavailable', 'codex', 'pt', () => '')).toContain('Nada foi encerrado')
  })
})

describe('crossSwitchPrompt', () => {
  const turns = [
    { role: 'user' as const, text: 'Add the export button to the report page' },
    { role: 'assistant' as const, text: 'Added it.', tools: [{ writes: ['src/Report.tsx'] }, { writes: ['src/Report.tsx', 'src/export.ts'] }] },
    { role: 'user' as const, text: 'now the tests', composer: true },
    { role: 'user' as const, text: 'Now write the tests' },
    { role: 'assistant' as const, text: 'Tests written; one fails on the CSV header.' },
  ]
  test('goal, state, last turns, files touched, and the pending message', () => {
    const p = crossSwitchPrompt({ lang: 'en', fromHarness: 'Claude Code', fromAccount: 'a@x', turns, pending: 'fix the CSV header' })
    expect(p).toContain('Claude Code (account a@x)')
    expect(p).toContain('## Goal (first message)\nAdd the export button')
    expect(p).toContain('## State (last assistant reply)\nTests written; one fails')
    expect(p).toContain('- Person: Now write the tests')
    expect(p).not.toContain('now the tests')
    expect(p).toContain('- src/Report.tsx\n- src/export.ts')
    expect(p.endsWith('fix the CSV header')).toBe(true)
  })
  test('long texts are clipped; an unreadable conversation is said', () => {
    const big = crossSwitchPrompt({ lang: 'pt', fromHarness: 'Codex', turns: [{ role: 'user', text: 'x'.repeat(5000) }] })
    expect(big.length).toBeLessThan(2000)
    expect(big).toContain('Confirme o estado')
    const none = crossSwitchPrompt({ lang: 'pt', fromHarness: 'Gemini CLI', turns: { unavailable: 'sem leitor' } })
    expect(none).toContain('não pôde ser lida (sem leitor)')
  })
})
