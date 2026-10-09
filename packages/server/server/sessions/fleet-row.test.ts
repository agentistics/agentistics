import { describe, expect, it } from 'bun:test'
import type { ControlSession } from '@agentistics/tui/control'
import { controlStrings } from '@agentistics/tui/control/i18n'
import { fleetRow, sessionHandleOf, verbReason } from './fleet-row'

const S = controlStrings('en')

function row(over: Partial<ControlSession> = {}): ControlSession {
  return {
    id: 'agentop-abcdef123456',
    title: 'a session',
    harness: 'claude',
    cwd: '/home/u/proj',
    project: 'proj',
    state: 'working',
    stateLabel: 'working',
    actionable: true,
    searchText: '',
    attached: false,
    ...over,
  } as ControlSession
}

const verb = (r: ReturnType<typeof fleetRow>, a: string) => r.verbs.find(v => v.action === a)!

describe('fleetRow — the verbs a web row is offered', () => {
  it('never offers attach: a browser tab has no terminal, so it carries the command instead', () => {
    const r = fleetRow(row(), S)
    expect(r.verbs.some(v => v.action === 'attach')).toBe(false)
    expect(r.attachCommand).toBe('agentop session attach agentop-abcd')
  })

  it('keeps the shape constant — an external row is DIMMED, never stripped down to nothing', () => {
    const lost = fleetRow(row({ state: 'lost' }), S)
    const external = fleetRow(row({ state: 'unknown', actionable: false }), S)
    // Same verbs in the same order: a bar that shrank from six buttons to one reads as a broken
    // feature, which is the reason `sessionActions` returns them all and dims the rest.
    expect(external.verbs.map(v => v.action)).toEqual(lost.verbs.map(v => v.action))
    expect(verb(external, 'rename').enabled).toBe(false)
    expect(verb(external, 'kill').enabled).toBe(false)
    // The ONE shape difference is the leading verb, and it is the cockpit's own rule: something
    // running is attached to, everything else is reopened, and they are never both live. Attaching
    // needs a terminal, so the running row spends that slot on the command instead.
    expect(fleetRow(row({ state: 'working' }), S).verbs.some(v => v.action === 'resume')).toBe(false)
  })

  it('an external row refuses in a SENTENCE, never silently', () => {
    const external = fleetRow(row({ state: 'unknown', actionable: false }), S)
    expect(verb(external, 'kill').reason).toBe(S.sessionsExternalNote)
    expect(verb(external, 'prompt').reason).toBe(S.sessionsExternalNote)
  })

  it('a CLOSED row is not called external — it is a conversation here that is not running', () => {
    const closed = fleetRow(row({ state: 'closed', actionable: false }), S)
    expect(verb(closed, 'kill').reason).toBeUndefined()
    // …and reopen is the verb it actually has, once a conversation resolves.
    expect(verb(closed, 'resume').enabled).toBe(false)
    const reopenable = fleetRow(
      row({ state: 'closed', actionable: false, resume: { sessionId: 'conv-1', title: 'a session' } }),
      S,
    )
    expect(verb(reopenable, 'resume').enabled).toBe(true)
  })

  it('a running row is offered PROMPT and no reopen; a lost one the reverse', () => {
    const running = fleetRow(row({ state: 'working' }), S)
    expect(verb(running, 'prompt').enabled).toBe(true)
    expect(running.verbs.some(v => v.action === 'resume')).toBe(false)

    const lost = fleetRow(row({ state: 'lost', resume: { sessionId: 'c', title: 't' } }), S)
    expect(verb(lost, 'resume').enabled).toBe(true)
    expect(verb(lost, 'prompt').enabled).toBe(false)
    // A reboot loses every backend session and keeps every name, so the naming verbs survive.
    expect(verb(lost, 'rename').enabled).toBe(true)
  })

  it('approve is off unless the session is genuinely asking AND the harness can answer', () => {
    expect(verb(fleetRow(row({ state: 'working' }), S), 'approve').enabled).toBe(false)
    const bare = fleetRow(row({ state: 'waiting-approval', canApprove: true }), S)
    expect(verb(bare, 'approve').enabled).toBe(true)
  })

  it('a numbered dialog this harness cannot pick from is REFUSED by name, not confirmed', () => {
    const blind = fleetRow(row({
      state: 'waiting-approval',
      dialogOptions: [{ number: 1, label: 'yes', selected: true }, { number: 2, label: 'no', selected: false }],
      chooseBlind: 'codex cannot be answered by number from here',
    }), S)
    // `sessionActions` still ENABLES the verb — pressing it opens the refusal that names what does
    // work — and the sentence travels with it so the page can say it.
    expect(blind.chooseBlind).toBe('codex cannot be answered by number from here')
    expect(blind.dialogOptions).toHaveLength(2)
  })

  it('carries the row\'s own blind sentences rather than inventing any', () => {
    const r = fleetRow(row({ approvalBlind: 'no probed rules for gemini' }), S)
    expect(r.approvalBlind).toBe('no probed rules for gemini')
    expect(verb(r, 'approve').reason).toBe('no probed rules for gemini')
  })

  it('F4.D — a structured row carries the modes it can be set to; a terminal row carries none', () => {
    const choices = [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }]
    const structured = fleetRow(row({ state: 'waiting', mode: choices[0], modeChoices: choices }), S)
    expect(structured.mode).toEqual(choices[0])
    expect(structured.modes).toEqual(choices)
    const terminal = fleetRow(row({ state: 'waiting', mode: { id: 'plan', label: 'plan mode' } }), S)
    expect(terminal.modes).toBeUndefined()
  })

  it('verbReason says nothing it cannot know', () => {
    expect(verbReason(row(), 'rename', S)).toBeUndefined()
    expect(verbReason(row({ state: 'closed' }), 'kill', S)).toBeUndefined()
  })

  it('the handle is what `agentop session attach` resolves', () => {
    expect(sessionHandleOf('agentop-abcdef123456')).toBe('agentop-abcd')
    expect(sessionHandleOf('short')).toBe('short')
  })
})

describe('fleetRow — an EXTERNAL session takes a write when it can be continued here (EXT.OPEN)', () => {
  const ext = (over: Parameters<typeof row>[0]) => fleetRow(row({ id: 'external:claude:c-1', state: 'unknown', actionable: false, harness: 'claude', ...over }), S)
  it('an exact conversation on a harness that resumes by id: prompt is ENABLED (the first write continues it here)', () => {
    expect(verb(ext({ conversationId: 'c-1' }), 'prompt').enabled).toBe(true)
  })
  it('no conversation named, or a harness with no resume: prompt keeps its sentence — read-only live', () => {
    expect(verb(ext({}), 'prompt').enabled).toBe(false)
    expect(verb(ext({ conversationId: 'c-1', harness: 'opencode' }), 'prompt').enabled).toBe(false)
  })
  it('the destructive verbs are untouched: an external row is never killed from its row', () => {
    expect(verb(ext({ conversationId: 'c-1' }), 'kill').enabled).toBe(false)
  })
})

describe('fleetRow — conversationLinkVia is a flat field, not only link.reason', () => {
  const link = (reason: 'assigned-id' | 'process-log' | 'first-sighting' | 'no-id-route') =>
    ({ provenance: reason === 'no-id-route' ? 'unrecoverable' : 'spawn', reason, exact: reason !== 'no-id-route' }) as const

  it('fills it from link.reason whenever the row has a conversation, whatever the harness', () => {
    for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi'] as const) {
      const r = fleetRow(row({ harness, conversationId: 'conv-1', link: link('process-log') }), S)
      expect(r.conversationLinkVia).toBe('process-log')
    }
  })

  it('says nothing while there is no id: no-id-route explains an absence, not a way of linking', () => {
    expect(fleetRow(row({ link: link('no-id-route') }), S).conversationLinkVia).toBeUndefined()
    expect(fleetRow(row({ conversationId: 'conv-1' }), S).conversationLinkVia).toBeUndefined()
  })
})

describe('fleetRow — "open in terminal" (F2.0b)', () => {
  it('is offered on a row running over its protocol, in the row\'s language, and enabled', () => {
    const r = fleetRow(row({ structured: true, state: 'waiting' }), S)
    expect(verb(r, 'terminal')).toEqual({ action: 'terminal' as never, label: 'Open in terminal', enabled: true })
    expect(verb(fleetRow(row({ structured: true }), controlStrings('pt')), 'terminal').label).toBe('Abrir no terminal')
  })

  it('is ABSENT (not dimmed) on a pane session — it already is a terminal', () => {
    expect(fleetRow(row(), S).verbs.some(v => (v.action as string) === 'terminal')).toBe(false)
  })

  it('is absent on a row agentop does not host, even if flagged', () => {
    expect(fleetRow(row({ structured: true, actionable: false, state: 'unknown' }), S).verbs.some(v => (v.action as string) === 'terminal')).toBe(false)
  })

  it('is the same for every harness — the server action, not the row, decides who can resume', () => {
    for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']) {
      expect(fleetRow(row({ harness, structured: true }), S).verbs.some(v => (v.action as string) === 'terminal')).toBe(true)
    }
  })
})
