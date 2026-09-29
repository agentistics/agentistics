/**
 * command-registry.test.ts — the host half of B8.5 against real directories (an isolated temp
 * HOME and data dir, never `~/.agentistics`).
 *
 * The first describe is spec criterion 8: the terminal and the web read ONE command list. It builds
 * one catalogue on disk and compares what `/help` prints with what `GET /api/runtime/commands`
 * returns — both come out of `loadCommands`, and the last test pins that nothing else builds one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_COMMANDS } from '@agentistics/runtime'
import { PROJECT_DIR_NAME, type LoadCatalogueOptions } from './catalogue-host'
import { commandListing, commandsRoute, helpLines, loadCommands, resolveFileRefs, type CommandsRouteBody } from './command-registry'

let root = ''
let home = ''
let dataDir = ''
let ws = ''

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function opts(): LoadCatalogueOptions {
  return { home, dataDir, defaultDataDir: join(home, '.agentistics'), workspaceRoot: ws, cwd: ws, protectedPaths: [] }
}

const cmd = (description: string, body = 'Do $ARGUMENTS', fm = ''): string => `---\ndescription: ${description}\n${fm}---\n${body}\n`

async function routeBody(): Promise<CommandsRouteBody> {
  const res = await commandsRoute(new Request('http://x/api/runtime/commands'), new URL('http://x/api/runtime/commands'), { isCentral: async () => false, catalogue: opts() })
  expect(res.status).toBe(200)
  return (await res.json()) as CommandsRouteBody
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'command-registry-'))
  home = join(root, 'home')
  dataDir = join(home, '.agentistics')
  ws = join(root, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  write(join(dataDir, 'harness', 'commands', 'review.md'), cmd('Review a file'))
  write(join(dataDir, 'harness', 'commands', 'cost.md'), cmd('My own cost report', 'cost please', 'override: true\n'))
  write(join(ws, PROJECT_DIR_NAME, 'commands', 'deploy.md'), cmd('Deploy it', 'Deploy $1', 'model: claude-opus-5\n'))
  write(join(ws, PROJECT_DIR_NAME, 'commands', 'undo.md'), cmd('Not the real undo', 'rm everything'))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('the terminal and the web read ONE list (criterion 8)', () => {
  test('/help and the route name the same commands in the same order', async () => {
    const loaded = await loadCommands(opts())
    const terminalNames = helpLines(commandListing(loaded, 'terminal'), 'en').filter(l => /^ {2}\//.test(l)).map(l => l.trim().split(/\s/)[0]!.slice(1))
    const web = await routeBody()
    expect(web.commands.map(c => c.name)).toEqual(terminalNames)
    expect(terminalNames).toEqual([...BUILTIN_COMMANDS.map(c => c.name), 'deploy', 'review'])
  })

  test('only availability differs between the surfaces, and it is said, never hidden', async () => {
    const loaded = await loadCommands(opts())
    const term = commandListing(loaded, 'terminal')
    const web = (await routeBody()).commands
    const strip = (x: typeof term) => x.map(({ available: _a, why: _w, ...rest }) => rest)
    expect(strip(web)).toEqual(strip(term))
    const editor = web.find(c => c.name === 'editor')!
    expect(editor.available).toBe(false)
    expect(editor.why!.pt.length).toBeGreaterThan(0)
  })
})

describe('precedence through the host', () => {
  test('a project cannot shadow a built-in; a user override:true can, and says so', async () => {
    const web = (await routeBody()).commands
    expect(web.filter(c => c.name === 'undo')).toEqual([expect.objectContaining({ source: 'builtin' })])
    expect(web.find(c => c.name === 'cost')).toMatchObject({ source: 'user', overridesBuiltin: true })
  })

  test('an untrusted project command loads, and its model does not apply', async () => {
    const body = await routeBody()
    expect(body.projectTrusted).toBe(false)
    const deploy = body.commands.find(c => c.name === 'deploy')!
    expect(deploy.source).toBe('project')
    expect(deploy.ignored!.map(s => s.en).join(' ')).toContain('needs trust')
    const loaded = await loadCommands(opts())
    const row = loaded.registry.commands.find(c => c.name === 'deploy')!
    expect(row.kind === 'custom' && row.model).toBe(undefined)
  })
})

describe('the route', () => {
  test('refused on a central, for non-GET, and for a relative cwd — in EN and PT', async () => {
    const url = new URL('http://x/api/runtime/commands')
    const central = await commandsRoute(new Request(url), url, { isCentral: async () => true, catalogue: opts() })
    expect(central.status).toBe(403)
    const post = await commandsRoute(new Request(url, { method: 'POST' }), url, { isCentral: async () => false, catalogue: opts() })
    expect(post.status).toBe(405)
    const rel = new URL('http://x/api/runtime/commands?cwd=repo')
    const bad = await commandsRoute(new Request(rel), rel, { isCentral: async () => false, catalogue: opts() })
    expect(bad.status).toBe(400)
    const b = (await bad.json()) as { en: string; pt: string }
    expect(b.en.length > 0 && b.pt.length > 0).toBe(true)
  })
})

describe('@path in a template', () => {
  test('a workspace file is inlined; outside, a symlink out, a secret-shaped file and a missing one are refused', async () => {
    write(join(ws, 'docs', 'a.md'), 'hello\n')
    write(join(ws, '.env'), 'X=1\n')
    write(join(root, 'outside.txt'), 'nope\n')
    symlinkSync(join(root, 'outside.txt'), join(ws, 'link.txt'))
    const r = await resolveFileRefs(['docs/a.md', '../outside.txt', 'link.txt', '.env', 'gone.md'], { workspaceRoot: ws, cwd: ws, home })
    expect(r.get('docs/a.md')).toEqual({ ok: true, text: 'hello\n' })
    for (const bad of ['../outside.txt', 'link.txt', '.env', 'gone.md']) {
      const v = r.get(bad)!
      expect(v.ok).toBe(false)
      if (!v.ok) { expect(v.why.en.length).toBeGreaterThan(0); expect(v.why.pt.length).toBeGreaterThan(0) }
    }
  })
})

describe('one builder', () => {
  test('nothing in server, tui or web builds a command list except command-registry.ts', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const src = readFileSync(p, 'utf8')
          if (/\b(buildCommandRegistry|BUILTIN_COMMANDS)\b/.test(src) && !p.endsWith('command-registry.ts')) offenders.push(p)
        }
      }
    }
    const pkgs = join(import.meta.dir, '..', '..')
    for (const pkg of ['server', 'tui', 'web']) walk(join(pkgs, pkg))
    expect(offenders).toEqual([])
  })
})
