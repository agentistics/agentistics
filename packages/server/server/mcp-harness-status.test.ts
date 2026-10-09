import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  HARNESS_MCP, findDuplicates, normalizeMcpUrl, parseAgyMcpList, parseClaudeMcpList, parseCodexMcpListJson,
  parseCopilotMcpList, parseGeminiMcpList, parseOpencodeMcpList, wouldDuplicate, type McpHarnessServer,
} from './mcp-harness-status'

// Every fixture below is a capture from the installed CLI (see `HARNESS_MCP.measured`), pasted
// verbatim — a parser tested against hand-written output is a parser tested against itself.

const CLAUDE = `Checking MCP server health…

figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
echo: bun run /home/u/fake/mcp-echo.ts - ✔ Connected
broken: /nonexistent/bin  - ✘ Failed to connect — ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/bin'
claude.ai Slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
repo: npx -y thing - ⏸ Pending approval
`

describe('parseClaudeMcpList', () => {
  const r = parseClaudeMcpList(CLAUDE)!
  const by = (n: string) => r.servers.find(s => s.name === n)!
  test('reads every row, including names with colons and spaces', () => {
    expect(r.servers.map(s => s.name)).toEqual(['figma', 'plugin:figma:figma', 'echo', 'broken', 'claude.ai Slack', 'repo'])
  })
  test('the case that lost a user: needs authentication', () => {
    expect(by('figma')).toMatchObject({ state: 'needs-auth', target: 'https://mcp.figma.com/mcp', transport: 'http' })
    expect(by('plugin:figma:figma').state).toBe('needs-auth')
    expect(by('claude.ai Slack').state).toBe('needs-auth')
  })
  test('connected, error (with the harness words) and pending', () => {
    expect(by('echo')).toMatchObject({ state: 'connected', transport: 'stdio', target: 'bun run /home/u/fake/mcp-echo.ts' })
    expect(by('broken').state).toBe('error')
    expect(by('broken').detail).toContain('ENOENT')
    expect(by('repo').state).toBe('pending')
  })
  test('no servers is an empty list; unreadable output is null, never an empty list', () => {
    expect(parseClaudeMcpList('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual({ servers: [] })
    expect(parseClaudeMcpList('Error: something broke')).toBeNull()
  })
})

const CODEX = JSON.stringify([
  { name: 'bearer', enabled: true, disabled_reason: null, transport: { type: 'streamable_http', url: 'https://example.com/mcp', bearer_token_env_var: 'FOO_TOKEN' }, auth_status: 'bearer_token' },
  { name: 'echo', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'true', args: [] }, auth_status: 'unsupported' },
  { name: 'figma', enabled: true, disabled_reason: null, transport: { type: 'streamable_http', url: 'https://mcp.figma.com/mcp' }, auth_status: 'not_logged_in' },
  { name: 'off', enabled: false, disabled_reason: 'user', transport: { type: 'stdio', command: 'x', args: ['a'] }, auth_status: 'unsupported' },
])

describe('parseCodexMcpListJson', () => {
  const r = parseCodexMcpListJson(CODEX)!
  const by = (n: string) => r.servers.find(s => s.name === n)!
  test('not logged in is needs-auth; credentials present is authenticated, NOT connected', () => {
    expect(by('figma').state).toBe('needs-auth')
    expect(by('bearer')).toMatchObject({ state: 'authenticated', detail: 'bearer token' })
  })
  test('a stdio server has no auth concept and no health: unknown', () => {
    expect(by('echo')).toMatchObject({ state: 'unknown', transport: 'stdio', target: 'true' })
  })
  test('disabled wins over everything else', () => {
    expect(by('off')).toMatchObject({ state: 'disabled', target: 'x a' })
  })
  test('not JSON is null', () => {
    expect(parseCodexMcpListJson('Name  Command')).toBeNull()
    expect(parseCodexMcpListJson('{}')).toBeNull()
  })
})

const OPENCODE = `\u001b[0m
┌  MCP Servers
│
●  ⚠ figma \u001b[90mneeds authentication
│      \u001b[90mhttps://mcp.figma.com/mcp
│
●  ✗ echo \u001b[90mfailed
│      MCP error -32000: Connection closed
│      \u001b[90mtrue
│
●  ✓ ok \u001b[90mconnected
│      \u001b[90mhttps://ok.example/mcp
│
└  3 server(s)
`

describe('parseOpencodeMcpList', () => {
  const r = parseOpencodeMcpList(OPENCODE)!
  test('state words, the error line and the target', () => {
    expect(r.servers).toEqual([
      { name: 'figma', target: 'https://mcp.figma.com/mcp', transport: 'http', state: 'needs-auth' },
      { name: 'echo', target: 'true', transport: 'stdio', state: 'error', detail: 'MCP error -32000: Connection closed' },
      { name: 'ok', target: 'https://ok.example/mcp', transport: 'http', state: 'connected' },
    ])
  })
  test('output without the box is null', () => { expect(parseOpencodeMcpList('boom')).toBeNull() })
})

describe('parseGeminiMcpList', () => {
  test('Disconnected is NOT turned into needs-auth: gemini does not say why', () => {
    const r = parseGeminiMcpList('Configured MCP servers:\n\n✗ figma: https://mcp.figma.com/mcp (http) - Disconnected\n✗ echo: true  (stdio) - Disconnected\n✓ ok: https://x/mcp (sse) - Connected\n')!
    expect(r.servers.map(s => [s.name, s.state, s.transport])).toEqual([
      ['figma', 'disconnected', 'http'], ['echo', 'disconnected', 'stdio'], ['ok', 'connected', 'sse'],
    ])
  })
  test('an untrusted folder is a fact about the folder, not about the servers', () => {
    const r = parseGeminiMcpList('Warning: MCP servers are configured but disabled because this folder is untrusted.\nUser-level servers are also suppressed in untrusted folders to prevent accidental side-effects.\n\nConfigured MCP servers:\n\n○ figma: https://mcp.figma.com/mcp (http) - Disabled\n')!
    expect(r.untrustedFolder).toBe(true)
    expect(r.servers[0]!.state).toBe('unknown')
  })
  test('unreadable is null', () => { expect(parseGeminiMcpList('???')).toBeNull() })
})

describe('parseCopilotMcpList / parseAgyMcpList', () => {
  test('copilot lists configuration only', () => {
    const r = parseCopilotMcpList('User servers:\n  figma (http)\n  echo (local)\n')!
    expect(r.servers.map(s => [s.name, s.state, s.transport])).toEqual([['figma', 'unknown', 'http'], ['echo', 'unknown', 'stdio']])
    expect(parseCopilotMcpList('No MCP servers configured.\n\nAdd a server with:\n')).toEqual({ servers: [] })
  })
  test('agy table', () => {
    const r = parseAgyMcpList('NAME   TYPE   STATUS   COMMAND/URL\necho   stdio  enabled  true\nfigma  http   disabled  https://mcp.figma.com/mcp\n')!
    expect(r.servers).toEqual([
      { name: 'echo', target: 'true', transport: 'stdio', state: 'unknown' },
      { name: 'figma', target: 'https://mcp.figma.com/mcp', transport: 'http', state: 'disabled' },
    ])
    expect(parseAgyMcpList('No MCP servers configured.')).toEqual({ servers: [] })
    expect(parseAgyMcpList('nope')).toBeNull()
  })
})

describe('HARNESS_MCP', () => {
  test('every harness decides what it offers, and a missing capability carries its sentence', () => {
    for (const id of HARNESS_ORDER) {
      const s = HARNESS_MCP[id]
      expect(s.measured.length).toBeGreaterThan(10)
      if (s.login === null) expect(s.noLogin ?? s.noList).toBeDefined()
      if (s.list === null) expect(s.noList).toBeDefined()
    }
  })
  test('login argv: claude asks for the URL instead of a browser; names are one argv element', () => {
    expect(HARNESS_MCP.claude.login!.argv('plugin:figma:figma')).toEqual(['mcp', 'login', 'plugin:figma:figma', '--no-browser'])
    expect(HARNESS_MCP.codex.login!.argv('figma')).toEqual(['mcp', 'login', 'figma'])
    expect(HARNESS_MCP.opencode.login!.argv('figma')).toEqual(['mcp', 'auth', 'figma'])
  })
  test('only claude can take the redirect URL back (printed by its own prompt)', () => {
    expect(HARNESS_MCP.claude.login!.pasteBack).toBe(true)
    expect(HARNESS_MCP.codex.login!.pasteBack).toBe(false)
  })
})

describe('the no-duplicate rule', () => {
  const s = (name: string, target: string): McpHarnessServer => ({ name, target, transport: 'http', state: 'needs-auth' })
  test('one URL under two names is reported, in listing order', () => {
    const d = findDuplicates([s('figma', 'https://mcp.figma.com/mcp'), s('plugin:figma:figma', 'https://MCP.figma.com/mcp/')])
    expect([...d]).toEqual([['plugin:figma:figma', 'figma']])
  })
  test('stdio servers never collide on a command', () => {
    expect(findDuplicates([{ name: 'a', target: 'true', transport: 'stdio', state: 'unknown' }, { name: 'b', target: 'true', transport: 'stdio', state: 'unknown' }]).size).toBe(0)
  })
  test('adding a second name for a listed URL is flagged; re-adding the same name is an edit', () => {
    const list = [s('plugin:figma:figma', 'https://mcp.figma.com/mcp')]
    expect(wouldDuplicate(list, 'figma', 'https://mcp.figma.com/mcp')).toBe('plugin:figma:figma')
    expect(wouldDuplicate(list, 'plugin:figma:figma', 'https://mcp.figma.com/mcp')).toBeNull()
    expect(wouldDuplicate(list, 'other', 'https://other.example/mcp')).toBeNull()
  })
  test('url normalisation', () => { expect(normalizeMcpUrl('HTTPS://A.b/c/')).toBe('https://a.b/c') })
})
