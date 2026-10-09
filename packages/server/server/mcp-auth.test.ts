import { beforeEach, describe, expect, test } from 'bun:test'
import {
  cancelMcpAuth, forgetMcpAuthFlows, forgetMcpStatusCache, mcpOverview, mcpStatus, pasteMcpAuth, pollMcpAuth,
  startMcpAuth, type McpAuthDeps,
} from './mcp-auth'
import { MCP_AUTH_SOCKET } from './sessions/tmux-socket'

const NEEDS = `Checking MCP server health…\n\nfigma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\nplugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\nok: bun run x.ts - ✔ Connected\n`
const DONE = `Checking MCP server health…\n\nfigma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected\nplugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\n`
const URL_SCREEN = `Starting authentication for "figma"…\nVisit this URL to authorize:\n  https://www.figma.com/oauth/mcp?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A49393%2Fcallback\n\nOr paste the redirect URL here:\n`

interface World {
  deps: McpAuthDeps
  now: number
  list: string
  screen: string | null
  runs: string[][]
  tmuxCalls: string[][]
  tmuxOk: boolean
  bins: Set<string>
}

function world(): World {
  const w: World = {
    now: 1_000_000, list: NEEDS, screen: null, runs: [], tmuxCalls: [], tmuxOk: true, bins: new Set(['claude', 'codex', 'gemini', 'tmux']),
    deps: undefined as unknown as McpAuthDeps,
  }
  let n = 0
  w.deps = {
    async run(bin, argv) {
      w.runs.push([bin, ...argv])
      if (!w.bins.has(bin)) return { code: null, out: '', missing: true }
      if (bin === 'codex') return { code: 0, out: JSON.stringify([{ name: 'figma', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.figma.com/mcp' }, auth_status: 'not_logged_in' }]) }
      return { code: 0, out: w.list }
    },
    async tmux(args) {
      w.tmuxCalls.push(args)
      const cmd = args[2]
      if (args[0] === '-V') return { code: w.tmuxOk ? 0 : 127, out: '', err: '' }
      if (cmd === 'capture-pane') return w.screen === null ? { code: 1, out: '', err: 'no session' } : { code: 0, out: w.screen, err: '' }
      return { code: 0, out: '', err: '' }
    },
    hasBin: b => w.bins.has(b),
    now: () => w.now,
    id: () => `id${++n}`,
    home: () => '/home/u',
  }
  return w
}

beforeEach(() => { forgetMcpAuthFlows(); forgetMcpStatusCache() })

describe('mcpStatus', () => {
  test('reads the harness list, flags what can be authenticated and reports duplicates without merging them', async () => {
    const w = world()
    const s = await mcpStatus('claude', {}, w.deps)
    expect(s.kind).toBe('ok')
    const by = (n: string) => s.servers.find(x => x.name === n)!
    expect(by('figma')).toMatchObject({ state: 'needs-auth', canAuthenticate: true })
    expect(by('plugin:figma:figma')).toMatchObject({ duplicateOf: 'figma', canAuthenticate: true })
    expect(by('ok')).toMatchObject({ state: 'connected', canAuthenticate: false })
    expect(s.servers).toHaveLength(3) // nothing created, nothing dropped
  })
  test('is cached, shares nothing across harnesses, and a refresh re-reads', async () => {
    const w = world()
    await mcpStatus('claude', {}, w.deps); await mcpStatus('claude', {}, w.deps)
    expect(w.runs).toHaveLength(1)
    await mcpStatus('claude', { refresh: true }, w.deps)
    expect(w.runs).toHaveLength(2)
    w.now += 60_000
    await mcpStatus('claude', {}, w.deps)
    expect(w.runs).toHaveLength(3)
  })
  test('concurrent askers share one CLI run', async () => {
    const w = world()
    await Promise.all([mcpStatus('claude', {}, w.deps), mcpStatus('claude', {}, w.deps), mcpStatus('claude', {}, w.deps)])
    expect(w.runs).toHaveLength(1)
  })
  test('a missing CLI, an unreadable list and a harness with no mcp command are three different answers', async () => {
    const w = world()
    expect((await mcpStatus('copilot', {}, w.deps)).kind).toBe('cli-missing')
    w.list = 'Error: boom'
    const failed = await mcpStatus('claude', {}, w.deps)
    expect(failed.kind).toBe('failed')
    expect(failed.message!.en).toContain('boom')
    const kimi = await mcpStatus('kimi', {}, w.deps)
    expect(kimi).toMatchObject({ kind: 'no-mcp-command', servers: [] })
    expect(kimi.message!.pt).toContain('Kimi')
  })
  test('a failed read is not cached', async () => {
    const w = world()
    w.list = 'Error: boom'
    await mcpStatus('claude', {}, w.deps)
    w.list = NEEDS
    expect((await mcpStatus('claude', {}, w.deps)).kind).toBe('ok')
  })
  test('codex: signed-out OAuth servers can be authenticated', async () => {
    const w = world()
    const s = await mcpStatus('codex', {}, w.deps)
    expect(s.servers[0]).toMatchObject({ name: 'figma', state: 'needs-auth', canAuthenticate: true })
  })
  test('gemini lists but cannot authenticate: no row offers the button', async () => {
    const w = world()
    w.list = 'Configured MCP servers:\n\n✗ figma: https://mcp.figma.com/mcp (http) - Disconnected\n'
    const s = await mcpStatus('gemini', {}, w.deps)
    expect(s.servers[0]).toMatchObject({ state: 'disconnected', canAuthenticate: false })
  })
})

describe('mcpOverview', () => {
  test('says per harness what it can do and, when it cannot, why', () => {
    const w = world()
    const o = Object.fromEntries(mcpOverview(w.deps).map(h => [h.id, h]))
    expect(o.claude).toMatchObject({ installed: true, canList: true, canAuthenticate: true })
    expect(o.gemini!.note!.en).toContain('/mcp auth')
    expect(o.copilot).toMatchObject({ installed: false, canAuthenticate: false })
    expect(o.kimi).toMatchObject({ canList: false })
    expect(Object.keys(o).sort()).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'gemini', 'kimi', 'opencode'])
  })
})

describe('startMcpAuth — the name is never free text', () => {
  test('a name the harness does not list is refused and nothing is spawned', async () => {
    const w = world()
    const r = await startMcpAuth({ harness: 'claude', server: 'figma --evil', lang: 'en' }, w.deps)
    expect(r).toMatchObject({ ok: false, code: 'not-listed' })
    expect(w.tmuxCalls.some(c => c[2] === 'new-session')).toBe(false)
  })
  test('a connected server is not asked to authenticate', async () => {
    const w = world()
    expect(await startMcpAuth({ harness: 'claude', server: 'ok', lang: 'en' }, w.deps)).toMatchObject({ ok: false, code: 'not-needed' })
  })
  test('harnesses without a login say so in words', async () => {
    const w = world()
    const r = await startMcpAuth({ harness: 'gemini', server: 'figma', lang: 'pt' }, w.deps)
    expect(r).toMatchObject({ ok: false, code: 'no-login' })
    expect((r as { message: string }).message).toContain('/mcp auth')
    expect(await startMcpAuth({ harness: 'nope', server: 'x', lang: 'en' }, w.deps)).toMatchObject({ ok: false, code: 'unknown-harness' })
  })
  test('the pane runs the harness argv as separate words on its OWN socket, once per server', async () => {
    const w = world()
    const r = await startMcpAuth({ harness: 'claude', server: 'plugin:figma:figma', lang: 'en' }, w.deps)
    expect(r.ok).toBe(true)
    const made = w.tmuxCalls.find(c => c[2] === 'new-session')!
    expect(made.slice(0, 2)).toEqual(['-L', MCP_AUTH_SOCKET])
    const tail = made.slice(made.indexOf('--') + 1)
    expect(tail.slice(0, 2)).toEqual(['sh', '-c'])
    expect(tail.slice(3)).toEqual(['sh', 'claude', 'mcp', 'login', 'plugin:figma:figma', '--no-browser'])
    // the leftover-clearing happens on our socket only, once
    expect(w.tmuxCalls.filter(c => c.includes('kill-server'))).toEqual([['-L', MCP_AUTH_SOCKET, 'kill-server']])
    // pressing again returns the flow in flight
    const again = await startMcpAuth({ harness: 'claude', server: 'plugin:figma:figma', lang: 'en' }, w.deps)
    expect(again.ok && r.ok && again.flow.id === r.flow.id).toBe(true)
    expect(w.tmuxCalls.filter(c => c[2] === 'new-session')).toHaveLength(1)
  })
  test('no tmux is said, not guessed around', async () => {
    const w = world(); w.tmuxOk = false
    expect(await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)).toMatchObject({ ok: false, code: 'no-tmux' })
  })
  test('a CLI that is not installed', async () => {
    const w = world(); w.bins.delete('claude')
    expect(await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)).toMatchObject({ ok: false, code: 'no-cli' })
  })
})

describe('the whole sign-in, with a scripted pane', () => {
  test('needs-auth -> link -> paste -> connected, and the pane is cleaned up', async () => {
    const w = world()
    const started = await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)
    if (!started.ok) throw new Error('start failed')
    const id = started.flow.id
    expect(started.flow.phase).toBe('starting')

    w.screen = 'Starting authentication…'
    expect((await pollMcpAuth(id, 'en', w.deps))!.phase).toBe('starting')

    w.screen = URL_SCREEN
    const awaiting = (await pollMcpAuth(id, 'en', w.deps))!
    expect(awaiting).toMatchObject({ phase: 'awaiting', pasteBack: true })
    expect(awaiting.url).toContain('figma.com/oauth')

    // a bad paste never reaches the pane
    const bad = await pasteMcpAuth(id, 'rm -rf ~', 'en', w.deps)
    expect(bad.ok).toBe(false)
    expect(w.tmuxCalls.some(c => c[2] === 'send-keys')).toBe(false)

    // a good one is typed literally, then Enter
    w.screen = `${URL_SCREEN}\nAuthentication successful.\n\n[agentop-exit:0]\n`
    w.list = DONE
    const pasted = await pasteMcpAuth(id, 'http://localhost:49393/callback?code=abc&state=xyz', 'en', w.deps)
    expect(pasted.ok).toBe(true)
    const keys = w.tmuxCalls.filter(c => c[2] === 'send-keys')
    expect(keys[0]!.slice(3)).toEqual(['-t', 'agentop-' + id, '-l', 'http://localhost:49393/callback?code=abc&state=xyz'])
    expect(keys[1]!.slice(-1)).toEqual(['Enter'])
    expect(pasted.ok && pasted.flow).toMatchObject({ phase: 'connected', verified: true })
    expect(w.tmuxCalls.some(c => c[2] === 'kill-session' && c.includes('agentop-' + id))).toBe(true)

    // the list the UI shows next is a fresh read, not the cached needs-auth
    const after = await mcpStatus('claude', {}, w.deps)
    expect(after.servers.find(s => s.name === 'figma')!.state).toBe('connected')
  })
  test('exit 0 while the harness still says needs-auth is a failure with a sentence', async () => {
    const w = world()
    const s = await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)
    if (!s.ok) throw new Error()
    w.screen = `${URL_SCREEN}\n[agentop-exit:0]\n` // list still says NEEDS
    const v = (await pollMcpAuth(s.flow.id, 'en', w.deps))!
    expect(v.phase).toBe('failed')
    expect(v.message).toContain('still says it needs authentication')
  })
  test('a CLI failure surfaces its own words, without the URL', async () => {
    const w = world()
    const s = await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'pt' }, w.deps)
    if (!s.ok) throw new Error()
    w.screen = `${URL_SCREEN}\nCouldn't complete authentication: access_denied\n[agentop-exit:1]`
    const v = (await pollMcpAuth(s.flow.id, 'pt', w.deps))!
    expect(v.phase).toBe('failed')
    expect(v.message).toContain('access_denied')
    expect(v.message).not.toContain('http')
  })
  test('codex finishes by itself; paste is refused with the reason, and the exit code verifies through the list', async () => {
    const w = world()
    const s = await startMcpAuth({ harness: 'codex', server: 'figma', lang: 'en' }, w.deps)
    if (!s.ok) throw new Error()
    w.screen = 'Authorize `figma` by opening this URL in your browser:\nhttps://www.figma.com/oauth/mcp?x=1\n'
    expect((await pollMcpAuth(s.flow.id, 'en', w.deps))).toMatchObject({ phase: 'awaiting', pasteBack: false })
    const p = await pasteMcpAuth(s.flow.id, 'http://localhost:1/cb?code=a', 'en', w.deps)
    expect(p).toMatchObject({ ok: false })
    expect((p as { message: string }).message).toContain('finishes by itself')
  })
  test('cancel ends the flow and kills the pane; an unknown id is null', async () => {
    const w = world()
    const s = await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)
    if (!s.ok) throw new Error()
    expect((await cancelMcpAuth(s.flow.id, 'en', w.deps))!.phase).toBe('cancelled')
    expect(w.tmuxCalls.some(c => c[2] === 'kill-session')).toBe(true)
    expect(await pollMcpAuth('nope', 'en', w.deps)).toBeNull()
    expect(await cancelMcpAuth('nope', 'en', w.deps)).toBeNull()
  })
  test('the pane dying under a flow fails it', async () => {
    const w = world()
    const s = await startMcpAuth({ harness: 'claude', server: 'figma', lang: 'en' }, w.deps)
    if (!s.ok) throw new Error()
    w.screen = null
    expect((await pollMcpAuth(s.flow.id, 'en', w.deps))!.phase).toBe('failed')
  })
  test('at most three at once', async () => {
    const w = world()
    w.list = `Checking MCP server health…\n\na: https://a.example/mcp (HTTP) - ! Needs authentication\nb: https://b.example/mcp (HTTP) - ! Needs authentication\nc: https://c.example/mcp (HTTP) - ! Needs authentication\nd: https://d.example/mcp (HTTP) - ! Needs authentication\n`
    for (const n of ['a', 'b', 'c']) expect((await startMcpAuth({ harness: 'claude', server: n, lang: 'en' }, w.deps)).ok).toBe(true)
    expect(await startMcpAuth({ harness: 'claude', server: 'd', lang: 'en' }, w.deps)).toMatchObject({ ok: false, code: 'too-many' })
  })
})
