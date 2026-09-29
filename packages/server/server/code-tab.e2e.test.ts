/**
 * code-tab.e2e.test.ts — the M1-style run for the `code` tab (Harness TUI P1 + P2), fully offline.
 *
 * The WHOLE control center is mounted on the `code` tab (the one Ink app, D-TUI-3) with the REAL
 * server `CodeHost` behind it: a real sqlite session store, content store, native tools and policy
 * in a temp dir, and a SCRIPTED provider client — no network, no key, no journal, and nothing under
 * the machine's own `~/.agentistics`. Everything the person does goes through the keyboard:
 *
 *   n → the wizard's task step → enter (the task) → enter (review: start) → type a prompt → enter
 *   → the model asks for a file.patch → the permission card shows the patch's real -/+ lines and the
 *     POLICY's options → d opens the full diff → "allow for this session" applies it → the file on
 *     disk changed, and the answer carries its receipt (CD-06)
 *   → a second prompt → the model asks for a shell command → esc denies it (the policy's own Deny)
 *     → the row says it was denied by you, and the command never ran.
 *
 * P2 then walks the same session: the first turn folded to one line (CD-05), the session rule in the
 * panel (CD-16), shift+tab through ask → edits → plan → ask with the dropped rule SAID (CD-15), the
 * inspector and the timeline (CD-13/14), /copy (CD-19), ctrl+r putting a prompt back without sending
 * it (CD-18), and `?` (GL-04).
 *
 * Frames are written to `AGENTISTICS_CODE_FRAMES` when set, at 108 and 80 columns, so the handback
 * can attach exactly what this run drew.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { render } from 'ink-testing-library'
import { fromAnthropicStopReason, fromAnthropicUsage } from '@agentistics/core'
import type { InvocationResult, ProviderClient, ProviderContent } from '@agentistics/runtime'
import { ControlCenter } from '@agentistics/tui/control/ControlCenter'
import type { ControlHost, ControlStatus } from '@agentistics/tui/control'
import { createCodeHost, type CodeTasksApi, type ServerCodeHost } from './code-host'
import { createRuntimeHost, type RuntimeHost } from './runtime-host'

const ESC = '\x1b'
const plain = (f: string | undefined) => (f ?? '').replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms))

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

function scripted(turns: ProviderContent[][]): ProviderClient {
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: false, editPolicy: 'verbatim' as never },
    async invokeOnce(req, attempt): Promise<InvocationResult> {
      const content = turns.shift()
      if (!content) throw new Error('script exhausted')
      n += 1
      return {
        invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
        startedAt: '2026-09-28T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
        servedModel: req.model,
        usage: fromAnthropicUsage({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 }).usage,
        usageAnomalies: [], content,
        stopReason: fromAnthropicStopReason(content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
      }
    },
  }
}

const roots: string[] = []
const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const d of disposers.splice(0)) await d().catch(() => {})
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(d)
  return d
}

/** An in-memory board: the filing is asserted, and nothing touches the machine's own task book. */
function board() {
  const tasks = [{ id: 't-7e1a00aa', title: 'Fix the slice boundary', status: 'todo' }]
  const filed: { taskId: string; sessionId: string }[] = []
  const api: CodeTasksApi = {
    async list() { return tasks },
    async statuses() { return [{ id: 'todo', label: 'To do' }, { id: 'in_progress', label: 'In progress' }, { id: 'done', label: 'Done' }] },
    async create(title) { const t = { id: `t-${tasks.length}0000000`, title, status: 'todo' }; tasks.push(t); return t },
    async attach(taskId, sessionId) { filed.push({ taskId, sessionId }); return { ok: true } },
    async taskOf(sessionId) {
      const f = filed.find(x => x.sessionId === sessionId)
      const t = f && tasks.find(x => x.id === f.taskId)
      return t ? { taskId: t.id, title: t.title } : null
    },
  }
  return { api, filed }
}

const STATUS: ControlStatus = {
  mode: 'solo', modeLabel: 'solo', services: [], version: '1.0.0',
} as unknown as ControlStatus

/** The rest of the cockpit is not under test: a host that answers at once and performs nothing. */
function shellHost(code: ServerCodeHost): ControlHost {
  const done = async () => ({ ok: true, message: '' })
  return {
    refresh: async () => STATUS,
    lastStatus: () => STATUS,
    start: done, connect: done, disconnect: done, restart: done, stop: done, setMode: done,
    initCentral: done, upgrade: done, pendingArchiveMode: async () => null, setArchiveMode: done,
    enableBoot: done, setLang: async () => {}, setSessionView: async () => {}, setMouse: async () => {},
    setSessionPollMs: async () => {}, onOutput: () => () => {}, readLog: async () => [],
    sessions: async () => ({ sessions: [], attention: 0, rang: [] }),
    code,
  } as unknown as ControlHost
}

const ORIGINAL = ['export function slice(buf, start, len) {', '  if (len <= 0) return []', '  const end = start + len', '  if (end > buf.length - 1) return null', '  return buf.subarray(start, end)', '}', ''].join('\n')
const PATCH = [
  '*** Begin Patch',
  '*** Update File: slice.ts',
  '@@ export function slice(buf, start, len) {',
  '   const end = start + len',
  '-  if (end > buf.length - 1) return null',
  '+  if (end > buf.length) return null',
  '+  // end is exclusive: a slice ending on the last byte is valid',
  '   return buf.subarray(start, end)',
  '*** End Patch',
].join('\n')

async function until(frame: () => string, text: string, ms = 5000): Promise<string> {
  const stop = Date.now() + ms
  for (;;) {
    if (frame().includes(text)) {
      // The footer's hints reach the shell through an effect, one render after the content that
      // changed them; a frame taken on the first sighting shows the previous focus's keys.
      await tick(120)
      return frame()
    }
    const f = frame()
    if (Date.now() > stop) throw new Error(`"${text}" never appeared. Last frame:\n${f}`)
    await tick(25)
  }
}

async function runAt(cols: number, rows: number) {
  const workspace = await tempDir('agt-codetab-ws-')
  const data = await tempDir('agt-codetab-data-')
  await writeFile(join(workspace, 'slice.ts'), ORIGINAL)
  const client = scripted([
    // The runtime refuses to patch a file this session never read, so the model reads it first.
    [{ type: 'text', text: 'Reading the parser first.' }, use('tu_0', 'file__read', { path: 'slice.ts' })],
    [{ type: 'text', text: 'I will patch the boundary check.' }, use('tu_1', 'file__patch', { patch: PATCH })],
    [{ type: 'text', text: 'Patched. The slice now accepts the last byte.' }],
    [{ type: 'text', text: 'Running the build.' }, use('tu_2', 'shell__start', { command: 'make release-build' })],
    [{ type: 'text', text: 'Understood, I will not run it.' }],
  ])
  let runtimeP: Promise<RuntimeHost> | null = null
  const b = board()
  const code = createCodeHost({
    lang: () => 'en',
    model: 'claude-sonnet-5',
    cwd: workspace,
    flagOn: () => true,
    central: () => false,
    tasks: b.api,
    runtime: () => (runtimeP ??= createRuntimeHost({
      dbPath: join(data, 'sessions.db'), contentDir: join(data, 'content'), journal: null,
      clientFor: () => client, pid: process.pid, isAlive: () => true, runtimeVersion: 'runtime@code-tab-e2e',
    }).then(r => { disposers.push(() => r.dispose()); return r })),
  })
  disposers.push(() => code.dispose())

  const size = { columns: process.stdout.columns, rows: process.stdout.rows }
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true })
  disposers.push(async () => {
    Object.defineProperty(process.stdout, 'columns', { value: size.columns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: size.rows, configurable: true })
  })
  const element = React.createElement(ControlCenter, { host: shellHost(code), lang: 'en', initial: { tab: 'code' }, onExit: () => {} })
  const app = render(element)
  // ink-testing-library hardcodes a 100-column stdout; shadow it on the instance and re-render, the
  // way scripts/preview.tsx does, or every frame is laid out at 100 whatever size is under test.
  Object.defineProperty(app.stdout, 'columns', { get: () => cols, configurable: true })
  app.rerender(element)
  disposers.push(async () => app.unmount())
  const frame = () => plain(app.lastFrame())
  const frames: Record<string, string> = {}
  const keep = (name: string) => { frames[name] = frame() }
  const press = async (keys: string) => { app.stdin.write(keys); await tick() }

  await until(frame, 'No native session open')
  keep('01-empty')
  await press('n')
  await until(frame, 'Fix the slice boundary')
  keep('02-wizard-task')
  await press('\r')
  await until(frame, 'no sandbox: tools run as you')
  keep('03-wizard-review')
  await press('\r')
  await until(frame, 'no sandbox')
  expect(b.filed.length).toBe(1)
  expect(b.filed[0]!.taskId).toBe('t-7e1a00aa')

  for (const ch of 'fix the off-by-one in slice.ts') app.stdin.write(ch)
  await tick()
  await press('\r')
  const card = await until(frame, 'permission · file.patch')
  keep('04-permission-card')
  // The card carries the call's REAL change and the policy's own options, numbered in its order.
  expect(card).toContain('if (end > buf.length - 1) return null')
  expect(card).toContain('if (end > buf.length) return null')
  expect(card).toContain('1 Allow once')
  expect(card).toMatch(/\d Deny/)
  expect(card).toContain('no sandbox')
  // GL-05: with the card open the footer names the answer keys and the full diff, nothing else first.
  expect(card).toContain('1-3 answer')
  expect(card).toContain('d full diff')
  expect(card).not.toContain('/ commands')

  await press('d')
  await until(frame, 'end is exclusive')
  keep('05-full-diff')
  // CD-16: answer with the policy's "allow for this session" option, so a rule stands in the panel.
  const session = /(\d) Allow for this session/.exec(frame())
  expect(session).not.toBeNull()
  await press(session![1]!)
  await until(frame, 'The slice now accepts the last byte.')
  keep('06-applied')
  // CD-06: a finished answer carries its receipt; the scripted client streams nothing, so the ttft
  // reads N/A rather than a confident zero.
  expect(frame()).toMatch(/↳ [^\n]*ttft N\/A/)
  expect(frame()).not.toMatch(/ttft 0ms/)
  // CD-12: the runtime journals no money, the host prices through calcCost — labelled api-equivalent.
  if (cols >= 100) expect(frame()).toMatch(/this turn\s+USD \d/)
  expect(await readFile(join(workspace, 'slice.ts'), 'utf8')).toContain('if (end > buf.length) return null')

  for (const ch of 'now build it') app.stdin.write(ch)
  await tick()
  await press('\r')
  await until(frame, 'make release-build')
  await until(frame, 'permission · shell')
  keep('07-shell-card')
  await press(ESC)
  await until(frame, 'I will not run it.')
  // The run ends after its last text lands; the footer stops offering to cancel it then.
  for (const stop = Date.now() + 5000; frame().includes('esc cancel run') && Date.now() < stop;) await tick(25)
  keep('08-denied')
  expect(frame()).toContain('denied by you')
  expect(frame()).not.toContain('esc cancel run')
  // CD-05: with a later turn on screen, the first folds to one line — question · tools · cost.
  // At 80x24 the conversation scrolls it above the fold, so the line is asserted where it is on screen.
  if (cols >= 100) expect(frame()).toMatch(/▸ turn 1 · fix the off-by-one/)

  // CD-16: the "allow for this session" answer stands in the session panel until the session ends.
  if (cols < 100) await press('\x02')
  await until(frame, 'SESSION RULES')
  keep('09-session-rule')
  if (cols < 100) { await press(ESC); await tick(120) }

  // CD-15: shift+tab cycles the permission mode, and the chrome says which. ask → edits is LOOSER,
  // and B4.7 drops the session's approvals on a looser switch — the sentence says so.
  await press(`${ESC}[Z`)
  await until(frame, 'mode edits')
  await until(frame, '1 session rule dropped. Mode: edits')
  keep('10-mode-edits')
  await press(`${ESC}[Z`)
  await until(frame, 'mode plan')
  await press(`${ESC}[Z`)
  await until(frame, 'mode ask')

  // CD-13 / CD-14: the panel swaps to the inspector (tab) and the timeline (ctrl+t).
  await press('\t')
  await until(frame, '↑↓ picks the turn')
  keep('11-inspector')
  await press('\x14')
  await until(frame, 'WHERE THE TIME WENT')
  keep('12-timeline')
  // Wide, ctrl+t swaps the side panel back to the session; narrow, the panel owns the screen and esc
  // returns to the conversation.
  await press(cols >= 100 ? '\x14' : ESC)
  await tick(120)

  // CD-19: /copy says how many characters it copied — the last answer is the whole turn's text
  // ("Running the build." + a blank line + "Understood, I will not run it.").
  for (const ch of '/copy') app.stdin.write(ch)
  await tick()
  await press('\r')
  await until(frame, 'Copied 50 characters (OSC 52)')

  // CD-18: ctrl+r lists earlier prompts newest first; enter puts one back, never sends it.
  await press('\x12')
  const hist = await until(frame, 'prompt history')
  keep('13-history')
  expect(hist.indexOf('now build it')).toBeLessThan(hist.indexOf('fix the off-by-one'))
  await press('\r')
  await until(frame, 'Put back in the composer')
  expect(frame()).toContain('now build it')
  await press('\x15')

  // GL-04: `?` on an empty draft opens every key by screen, including this tab's.
  await press('?')
  await until(frame, 'CODE — THE NATIVE SESSION')
  keep('14-help')
  await press(ESC)
  await until(frame, 'I will not run it.')
  return frames
}

describe('the code tab, driven by keys against the real host and a scripted model', () => {
  for (const [cols, rows] of [[108, 36], [80, 24]] as const) {
    test(`start filed under a task, full diff, apply, deny, then the P2 panels, mode, history, copy and help — ${cols}x${rows}`, async () => {
      const frames = await runAt(cols, rows)
      for (const [name, f] of Object.entries(frames)) {
        for (const line of f.split('\n')) expect([...line].length).toBeLessThanOrEqual(cols)
        expect(f.split('\n').length).toBeLessThanOrEqual(rows)
        const out = process.env.AGENTISTICS_CODE_FRAMES
        if (out) {
          mkdirSync(out, { recursive: true })
          writeFileSync(join(out, `${cols}x${rows}-${name}.txt`), f + '\n')
        }
      }
    }, 60_000)
  }
})
