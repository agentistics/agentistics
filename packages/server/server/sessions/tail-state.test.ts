import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_ORDER, type ChatTurn, type HarnessId } from '@agentistics/core'
import { parseAntigravityChat } from './antigravity-chat'
import { readRecentChatTurns } from './chat-tail'
import { parseCodexChat } from './codex-chat'
import { parseCopilotChat } from './copilot-chat'
import { parseGeminiChatTurns } from './gemini-chat'
import { parseKimiChat } from './kimi-chat'
import type { HarnessTranscript } from './harness-transcript'
import { createSessionsPoller } from './sessions-host'
import {
  TAIL_SCREEN_REFRESH_MS, createTailStateMemo, tailActivity, tailSkipsScreen, tailStateOf, type TailReading,
} from './tail-state'
import type { BackendSession, ManagedSession, SessionBackend } from './types'

// Record shapes are the ones each parser's own test file pins (measured from the harness's files).
const claudeLine = (o: unknown) => JSON.stringify(o)
const claude = {
  user: (text: string) => claudeLine({ type: 'user', message: { content: text } }),
  say: (text: string) => claudeLine({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  tool: (name: string) => claudeLine({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } }),
  result: () => claudeLine({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
}
const codexLine = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-07-07T22:04:06.000Z', type: 'response_item', payload })
const codex = {
  user: (text: string) => codexLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
  say: (text: string) => codexLine({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }),
  tool: () => codexLine({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls' }) }),
  result: () => codexLine({ type: 'function_call_output', call_id: 'c1', output: 'a' }),
}
const copilotLine = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: 'x', timestamp: '2026-06-30T14:53:11.560Z' })
const copilot = {
  user: (text: string) => copilotLine('user.message', { content: text }),
  say: (text: string) => copilotLine('assistant.message', { content: text, toolRequests: [] }),
  tool: (text = '') => copilotLine('assistant.message', { content: text, toolRequests: [{ name: 'bash', arguments: { command: 'ls' } }] }),
}
const kimiLine = (o: Record<string, unknown>) => JSON.stringify({ time: 1785943919760, ...o })
const kimiLoop = (event: Record<string, unknown>) => kimiLine({ type: 'context.append_loop_event', event })
const kimi = {
  user: (text: string) => kimiLine({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } } }),
  say: (text: string) => kimiLoop({ type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text } }),
  tool: () => kimiLoop({ type: 'tool.call', name: 'Bash', args: { command: 'ls' } }),
}
const agyStep = (idx: number, o: Record<string, unknown>) => JSON.stringify({ step_index: idx, status: 'DONE', created_at: '2026-09-05T17:22:30Z', ...o })
const agy = {
  user: (idx: number, text: string) => agyStep(idx, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }),
  say: (idx: number, text: string) => agyStep(idx, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: text }),
  tool: (idx: number, content = '') => agyStep(idx, { source: 'MODEL', type: 'PLANNER_RESPONSE', content, tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }),
}
const gemini = {
  user: (text: string) => JSON.stringify({ id: `u-${text}`, timestamp: '2026-09-08T14:11:33.230Z', type: 'user', content: [{ text }] }),
  say: (text: string) => JSON.stringify({ id: `m-${text}`, timestamp: '2026-09-08T14:12:18.661Z', type: 'gemini', content: text, model: 'gemini-3.5-flash' }),
}

let dir = ''
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tail-state-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
async function claudeTurns(lines: string[]): Promise<ChatTurn[]> {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`)
  await writeFile(f, lines.join('\n') + '\n')
  return readRecentChatTurns(f, 6)
}

const state = (r: TailReading | undefined) => r === undefined ? 'unknown' : r.attention ? `attention:${r.attention}` : r.working ? 'working' : 'waiting'

describe('tailStateOf — per harness, from that harness\'s own record shapes', () => {
  it('claude', async () => {
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('fix it')])))).toBe('working')
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('fix it'), claude.say('looking'), claude.tool('Bash')])))).toBe('working')
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('fix it'), claude.tool('Bash'), claude.result()])))).toBe('working')
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('fix it'), claude.tool('Bash'), claude.result(), claude.say('done')])))).toBe('waiting')
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('which?'), claude.tool('AskUserQuestion')])))).toBe('attention:question')
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('plan'), claude.tool('ExitPlanMode')])))).toBe('attention:question')
    expect(state(tailStateOf('claude', await claudeTurns([claude.say('x'), claude.user('[Request interrupted by user]')])))).toBe('unknown')
    // STATED LIMIT: Claude's poll reader drops a tool_result line and names a call only while it is the
    // NEWEST line, so mid-turn after a result the tail ends on the text before it and reads as an end.
    // The screen-agreement guard (`tailActivity`) is what keeps that from becoming a false idle.
    expect(state(tailStateOf('claude', await claudeTurns([claude.user('go'), claude.say('looking'), claude.tool('Bash'), claude.result()])))).toBe('waiting')
  })
  it('codex', () => {
    expect(state(tailStateOf('codex', parseCodexChat([codex.user('go')])))).toBe('working')
    expect(state(tailStateOf('codex', parseCodexChat([codex.user('go'), codex.say('running'), codex.tool()])))).toBe('working')
    expect(state(tailStateOf('codex', parseCodexChat([codex.user('go'), codex.tool(), codex.result()])))).toBe('working')
    expect(state(tailStateOf('codex', parseCodexChat([codex.user('go'), codex.tool(), codex.result(), codex.say('done')])))).toBe('waiting')
  })
  it('copilot', () => {
    expect(state(tailStateOf('copilot', parseCopilotChat([copilot.user('go')])))).toBe('working')
    expect(state(tailStateOf('copilot', parseCopilotChat([copilot.user('go'), copilot.tool()])))).toBe('working')
    // Copilot writes a step's text and its calls in ONE message: still working.
    expect(state(tailStateOf('copilot', parseCopilotChat([copilot.user('go'), copilot.tool('checking')])))).toBe('working')
    expect(state(tailStateOf('copilot', parseCopilotChat([copilot.user('go'), copilot.tool(), copilot.say('done')])))).toBe('waiting')
  })
  it('kimi', () => {
    expect(state(tailStateOf('kimi', parseKimiChat([kimi.user('go')])))).toBe('working')
    expect(state(tailStateOf('kimi', parseKimiChat([kimi.user('go'), kimi.say('ok'), kimi.tool()])))).toBe('working')
    expect(state(tailStateOf('kimi', parseKimiChat([kimi.user('go'), kimi.tool(), kimi.say('done')])))).toBe('waiting')
  })
  it('antigravity', () => {
    expect(state(tailStateOf('antigravity', parseAntigravityChat([agy.user(0, 'go')])))).toBe('working')
    expect(state(tailStateOf('antigravity', parseAntigravityChat([agy.user(0, 'go'), agy.tool(1)])))).toBe('working')
    expect(state(tailStateOf('antigravity', parseAntigravityChat([agy.user(0, 'go'), agy.tool(1, 'listing')])))).toBe('working')
    expect(state(tailStateOf('antigravity', parseAntigravityChat([agy.user(0, 'go'), agy.tool(1), agy.say(2, 'done')])))).toBe('waiting')
  })
  it('gemini — its reader carries no tool calls, so only a person\'s newest message is stated', () => {
    expect(state(tailStateOf('gemini', parseGeminiChatTurns([gemini.user('go')], 6)))).toBe('working')
    expect(state(tailStateOf('gemini', parseGeminiChatTurns([gemini.user('go'), gemini.say('ok')], 6)))).toBe('unknown')
  })
  it('nothing to read, or a note the harness wrote, says nothing', () => {
    for (const h of HARNESS_ORDER) expect(tailStateOf(h, [])).toBeUndefined()
    expect(tailStateOf('codex', [{ role: 'user', text: '', system: 'the turn was aborted' }])).toBeUndefined()
    expect(tailStateOf(undefined, [{ role: 'user', text: 'x' }])).toBeUndefined()
  })
  it('a person\'s `!` command: working while it runs, waiting once it printed', () => {
    const shell = (running: boolean): ChatTurn => ({ role: 'user', text: '!ls', shell: { command: 'ls', summary: 'ls', running } })
    expect(state(tailStateOf('claude', [shell(true)]))).toBe('working')
    expect(state(tailStateOf('claude', [shell(false)]))).toBe('waiting')
  })
})

describe('tailActivity / tailSkipsScreen', () => {
  const idle: TailReading = { working: false, sig: 's1' }
  const busy: TailReading = { working: true, sig: 's1' }
  it('agreement is exact; a screen dialog wins; disagreement is the screen\'s', () => {
    expect(tailActivity(idle, 'waiting')).toEqual({ state: 'waiting', exact: true })
    expect(tailActivity(busy, 'working')).toEqual({ state: 'working', exact: true })
    expect(tailActivity(busy, 'waiting-approval')).toEqual({ state: 'waiting-approval', exact: false })
    expect(tailActivity(idle, 'working')).toEqual({ state: 'working', exact: false })
    expect(tailActivity(busy, 'waiting')).toEqual({ state: 'waiting', exact: false })
    expect(tailActivity({ working: true, attention: 'question', sig: 's' }, 'working')).toEqual({ state: 'waiting-approval', exact: true })
  })
  it('skips only an idle tail the screen agreed with, inside the refresh window, unforced', () => {
    const base = { reading: idle, agreedSig: 's1', lastScreenMs: 1000, nowMs: 2000, forced: false }
    expect(tailSkipsScreen(base)).toBe(true)
    expect(tailSkipsScreen({ ...base, reading: busy })).toBe(false)
    expect(tailSkipsScreen({ ...base, agreedSig: 's0' })).toBe(false)
    expect(tailSkipsScreen({ ...base, forced: true })).toBe(false)
    expect(tailSkipsScreen({ ...base, nowMs: 1000 + TAIL_SCREEN_REFRESH_MS })).toBe(false)
    expect(tailSkipsScreen({ ...base, reading: undefined })).toBe(false)
  })
})

const NOW = 1_786_600_000_000

function tailPoller(harness: HarnessId, o: { tail: () => ChatTurn[]; frame: () => string[]; now: () => number; on: boolean }) {
  const captures: string[] = []
  const session: BackendSession = { id: 'r1', createdMs: NOW - 600_000, attached: false, alive: true, lastActivityMs: NOW - 30_000 }
  const backend: SessionBackend = {
    id: 'tmux',
    async unavailable() { return undefined },
    async spawn() {},
    async list() { return [session] },
    async capture(id) { captures.push(id); return o.frame() },
    async captureTerminal() { return { lines: [], info: { cols: 80, rows: 0, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } } },
    async kill() { return true },
    attachCommand: id => ['tmux', 'attach', id],
    async detachHint() { return '' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
  }
  const reader: HarnessTranscript = {
    async resolve() { return '/x/transcript' },
    async read() { return { turns: o.tail(), older: false } },
    async readRecent() { return o.tail() },
  }
  const memo = createTailStateMemo()
  const managed: ManagedSession = { id: 'r1', harness, cwd: '/repo', createdAt: '2026-10-09T00:00:00Z', conversationId: `conv-${harness}` }
  const poller = createSessionsPoller({
    backend,
    readRegistry: async () => [managed],
    scanProcesses: async () => ({ procs: [] }),
    now: o.now,
    transcriptReader: () => reader,
    ...(o.on ? { tailState: () => memo } : {}),
  })
  return { poller, captures, memo }
}

describe('the poller — a no-driver row is read off its transcript tail (flag on)', () => {
  const idleTail: ChatTurn[] = [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done' }]
  for (const h of ['claude', 'codex', 'copilot', 'kimi', 'antigravity'] as const) {
    it(`${h}: an idle row stops capturing once the screen agreed; a new turn reopens the screen`, async () => {
      let t = NOW
      let tail = idleTail
      const { poller, captures, memo } = tailPoller(h, { tail: () => tail, frame: () => ['still'], now: () => t, on: true })
      await poller.poll() // first read: the screen is captured (nothing agreed yet)
      t += 5_000
      let snap = await poller.poll() // still frame + idle tail: they agree
      expect(snap.sessions[0]!.activity).toBe('waiting')
      const agreed = captures.length
      for (let i = 0; i < 3; i++) {
        t += 5_000
        snap = await poller.poll()
        expect(snap.sessions[0]!.activity).toBe('waiting')
      }
      expect(captures.length).toBe(agreed) // idle polls: no capture()
      // A new person's message: the screen is read again, every poll while working.
      tail = [...idleTail, { role: 'user', text: 'more' }]
      t += 5_000
      await poller.poll()
      expect(captures.length).toBe(agreed + 1)
      // An act forces one screen read even when idle.
      tail = idleTail
      t += 5_000; await poller.poll(); t += 5_000; await poller.poll()
      const before = captures.length
      memo.forceScreen('r1')
      t += 5_000; await poller.poll()
      expect(captures.length).toBe(before + 1)
      // And the refresh window reopens it.
      t += TAIL_SCREEN_REFRESH_MS
      await poller.poll()
      expect(captures.length).toBe(before + 2)
    })
  }

  it('gemini: the tail cannot tell an end, so the screen is read every poll', async () => {
    let t = NOW
    const { poller, captures } = tailPoller('gemini', { tail: () => idleTail, frame: () => ['still'], now: () => t, on: true })
    for (let i = 0; i < 4; i++) { await poller.poll(); t += 5_000 }
    expect(captures.length).toBe(4)
  })

  it('a question tool pending is waiting-approval, believed at once, and the screen is read for its options', async () => {
    let t = NOW
    const tail: ChatTurn[] = [{ role: 'user', text: 'go' }, { role: 'assistant', text: '', pending: true, tools: [{ name: 'AskUserQuestion' }] }]
    const { poller, captures } = tailPoller('claude', { tail: () => tail, frame: () => ['still'], now: () => t, on: true })
    const snap = await poller.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting-approval')
    t += 5_000; await poller.poll()
    expect(captures.length).toBe(2)
  })

  it('flag OFF: the screen, every poll, exactly as before', async () => {
    let t = NOW
    const { poller, captures } = tailPoller('claude', { tail: () => idleTail, frame: () => ['still'], now: () => t, on: false })
    for (let i = 0; i < 4; i++) { await poller.poll(); t += 5_000 }
    expect(captures.length).toBe(4)
  })
})
