/**
 * cli-code-undo.test.ts — H4's terminal half: `/undo` inside `agentop code` and the one-shot
 * `agentop code undo <id>`, fully offline (a scripted streaming client, a temp store and content
 * store under the host, a scripted stdin), plus the pure EN/PT rendering.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { fromAnthropicStopReason, fromAnthropicUsage } from '@agentistics/core'
import type { InvocationResult, ProviderClient, ProviderContent, ProviderJournalSink, ProviderRequest, ProviderStreamEvent } from '@agentistics/runtime'
import { createRuntimeHost } from './runtime-host.ts'
import { runCode, type CodeCliDeps, type CodeHostFactory } from './cli-code.ts'
import { isYes, renderUndo } from './code-undo-text.ts'

function streamingClient(turns: ProviderContent[][]): ProviderClient {
  const queue = [...turns]
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: true, editPolicy: 'verbatim' as never },
    async invokeOnce(): Promise<InvocationResult> { throw new Error('stream only') },
    stream(req: ProviderRequest, attempt: number) {
      const content = queue.shift()
      if (!content) throw new Error('script exhausted')
      n += 1
      async function* gen(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: 'started' }
        yield {
          type: 'end',
          result: {
            invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
            startedAt: '2026-09-29T12:00:00.000Z', latencyMs: 5, status: 'completed', messageId: `msg_${n}`,
            servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
            usageAnomalies: [], content: content!,
            stopReason: fromAnthropicStopReason(content!.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
          },
        }
      }
      return gen()
    },
  }
}

const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })
const ORIGINAL = "export const greeting = 'hello'\n"
const PATCH = [
  '*** Begin Patch', '*** Update File: hello.ts', '@@',
  "-export const greeting = 'hello'", "+export const greeting = 'hello, undo'",
  '*** End Patch',
].join('\n')

let ws: string
let dbDir: string

beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'agt-code-undo-ws-')))
  dbDir = await mkdtemp(join(tmpdir(), 'agt-code-undo-db-'))
  await writeFile(join(ws, 'hello.ts'), ORIGINAL)
  const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, env: gitTestEnv() })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
  await rm(dbDir, { recursive: true, force: true })
})

function hostFactory(client: ProviderClient): CodeHostFactory {
  return async (askerFor) => {
    const journal: ProviderJournalSink = { async append(b) { return { written: b.length, duplicates: 0 } } }
    const host = await createRuntimeHost({
      dbPath: join(dbDir, 'sessions.db'),
      contentDir: join(dbDir, 'content'),
      home: await mkdtemp(join(tmpdir(), 'agt-code-undo-home-')),
      journal,
      clientFor: () => client,
      askerFor,
    })
    return { host, content: host.content, journal, runtimeVersion: host.runtimeVersion }
  }
}

function deps(over: Partial<CodeCliDeps> & { lines?: string[] }): { deps: Partial<CodeCliDeps>; out: string[] } {
  const out: string[] = []
  const queue = [...(over.lines ?? [])]
  const { lines: _lines, ...rest } = over
  return {
    out,
    deps: {
      stdout: l => out.push(`${l}\n`),
      stderr: l => out.push(`!${l}\n`),
      write: c => out.push(c),
      isTty: true,
      cwd: ws,
      now: () => new Date('2026-09-29T00:00:00.000Z'),
      readLine: async () => (queue.length > 0 ? queue.shift()! : null),
      askTimeoutMs: 5000,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: h => clearTimeout(h),
      onInterrupt: () => () => {},
      flagOn: () => true,
      lang: async () => 'en',
      ...rest,
    },
  }
}

const patchRun = (): ProviderContent[][] => [
  [use('r1', 'file__read', { path: 'hello.ts' })],
  [use('p1', 'file__patch', { patch: PATCH })],
  [{ type: 'text', text: 'patched' }],
]

describe('agentop code — /undo', () => {
  test('reverts the last change set, asking for the write like any other, then says there is nothing left', async () => {
    // "1" allows the patch, "/undo", "1" allows the undo's write, "/undo" again, then leave.
    const { deps: d, out } = deps({ host: hostFactory(streamingClient(patchRun())), lines: ['1', '/undo', '1', '/undo', '/exit'] })
    const code = await runCode(['--model', 'claude-test', 'patch hello'], d)
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain(`reverted  ${join(ws, 'hello.ts')}`)
    expect(text).toContain('Undid 1 file(s).')
    expect(text).toContain('anything a shell command changed is not recorded')
    expect(text).toContain('Nothing to undo')
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe(ORIGINAL)
  })

  test('`agentop code undo <id>` after a restart: a file changed since is named, and --yes undoes nothing else (PT)', async () => {
    const first = deps({ host: hostFactory(streamingClient(patchRun())), lines: ['1', '/exit'] })
    expect(await runCode(['--model', 'claude-test', 'patch hello'], first.deps)).toBe(0)
    const sessionId = /session (ses_[0-9a-f]+)/.exec(first.out.join(''))![1]!
    await writeFile(join(ws, 'hello.ts'), 'the person rewrote it\n')

    const { deps: d, out } = deps({ host: hostFactory(streamingClient([])), lang: async () => 'pt', isTty: false })
    const code = await runCode(['undo', sessionId, '--yes'], d)
    const text = out.join('')
    expect(text).toContain(`${join(ws, 'hello.ts')} mudou depois que o agente o escreveu`)
    expect(text).toContain('0 arquivo(s) desfeito(s).')
    expect(code).toBe(0)
    expect(await readFile(join(ws, 'hello.ts'), 'utf8')).toBe('the person rewrote it\n')
  })

  test('without a terminal and without --yes, a change set that needs a yes writes nothing', async () => {
    const first = deps({ host: hostFactory(streamingClient(patchRun())), lines: ['1', '/exit'] })
    await runCode(['--model', 'claude-test', 'patch hello'], first.deps)
    const sessionId = /session (ses_[0-9a-f]+)/.exec(first.out.join(''))![1]!
    await writeFile(join(ws, 'hello.ts'), 'changed\n')

    const { deps: d, out } = deps({ host: hostFactory(streamingClient([])), isTty: false })
    expect(await runCode(['undo', sessionId], d)).toBe(1)
    expect(out.join('')).toContain('pass --yes')
  })
})

describe('renderUndo / isYes', () => {
  test('an earlier-turn change set says so and asks before writing', () => {
    const r = renderUndo({
      status: 'needs-confirmation', runId: 'run_1', lastTurn: false,
      ready: [{ path: '/w/a', op: 'delete', restore: null, expect: 'x' }], refused: [], sentence: '',
    }, 'en', 'ses_1')
    expect(r.lines).toEqual(['This change set is from an earlier turn, not the last one.', '  would revert  /w/a  (remove)'])
    expect(r.confirm).toBe('Undo these 1 file(s) from an earlier turn? [y/N] ')
  })

  test('refusals are worded per reason, in both languages', () => {
    expect(renderUndo({ status: 'refused', reason: 'run-in-progress', sentence: '' }, 'pt', 's').lines[0]).toContain('em andamento')
    expect(renderUndo({ status: 'refused', reason: 'session-not-found', sentence: '' }, 'en', 'ses_x').lines[0]).toBe('No such session: ses_x.')
  })

  test('only an explicit yes counts', () => {
    expect(['y', 'YES', 's', 'sim'].every(isYes)).toBe(true)
    expect(['', 'n', 'no', 'yeah', null].some(a => isYes(a as string | null))).toBe(false)
  })
})
