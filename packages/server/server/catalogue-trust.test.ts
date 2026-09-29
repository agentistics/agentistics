/**
 * catalogue-trust.test.ts — B8.3 end to end: the loader, the grants file and `agentop code
 * trust|untrust` against real directories (an isolated temp HOME and data dir, never
 * `~/.agentistics`). Spec §4; criteria 1 and 2; trust never lifts the floor or a user deny.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { decideByRules, type PolicyLayer, type RuleTarget } from '@agentistics/runtime'
import { loadCatalogue, PROJECT_DIR_NAME, type LoadCatalogueOptions, type LoadedCatalogue } from './catalogue-host'
import type { CatalogueItem } from './catalogue-plan'
import { runTrust, type TrustCliDeps } from './cli-catalogue'
import { runCode } from './cli-code'
import { grantsAuditPath, grantsPath } from './harness-grants'

let root = ''
let home = ''
let dataDir = ''
let ws = ''
const NOW = new Date('2026-09-29T12:00:00.000Z')

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function opts(extra: Partial<LoadCatalogueOptions> = {}): LoadCatalogueOptions {
  return { home, dataDir, defaultDataDir: join(home, '.agentistics'), workspaceRoot: ws, cwd: ws, protectedPaths: [], now: NOW, ...extra }
}

const load = (extra: Partial<LoadCatalogueOptions> = {}): Promise<LoadedCatalogue> => loadCatalogue(opts(extra))

function find(items: CatalogueItem[], kind: string, name: string, scope?: string): CatalogueItem[] {
  return items.filter(i => i.entry.kind === kind && i.entry.name === name && (scope === undefined || i.entry.scope === scope))
}

function cli(over: Partial<TrustCliDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const deps: Partial<TrustCliDeps> = {
    stdout: l => out.push(l),
    stderr: l => err.push(l),
    // The CLI's loader, pinned to this test's isolated home and data dir.
    load: o => loadCatalogue({ ...opts(), ...o }),
    isCentral: async () => false,
    lang: async () => 'en',
    cwd: ws,
    dataDir,
    now: () => NOW,
    ...over,
  }
  return { deps, out: () => out.join('\n'), err: () => err.join('\n') }
}

const trust = async (dir = ws, over: Partial<TrustCliDeps> = {}): Promise<{ code: number; out: string; err: string }> => {
  const h = cli(over)
  const code = await runTrust('trust', [dir], h.deps)
  return { code, out: h.out(), err: h.err() }
}
const untrust = async (dir = ws): Promise<{ code: number; out: string; err: string }> => {
  const h = cli()
  const code = await runTrust('untrust', [dir], h.deps)
  return { code, out: h.out(), err: h.err() }
}

const auditLines = (): Array<{ action: string; targetId: string; meta: Record<string, unknown> }> =>
  existsSync(grantsAuditPath(dataDir))
    ? readFileSync(grantsAuditPath(dataDir), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    : []

/** A project with every kind of power, plus text and restrictions. */
function writeProject(extra: { mcpServers?: Record<string, unknown> } = {}): void {
  write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({
    profile: 'build',
    rules: [
      { id: 'p-deny', effect: 'deny', match: { pathGlob: 'secrets/**' } },
      { id: 'p-ask', effect: 'ask', match: { commandPrefix: ['make', 'release'] } },
      { id: 'p-allow', effect: 'allow', match: { commandPrefix: ['make'] } },
    ],
    mcpServers: { db: { type: 'stdio', command: ['bunx', 'project-db-mcp'] }, ...extra.mcpServers },
    afterEdit: [{ match: '**/*.ts', run: ['bunx', 'biome', 'format', '{path}'] }],
  }))
  write(join(ws, PROJECT_DIR_NAME, 'commands', 'ship.md'), '---\ndescription: ship it\n---\nShip $ARGUMENTS\n')
  write(join(ws, PROJECT_DIR_NAME, 'profiles', 'build.json'), JSON.stringify({ rules: [{ id: 'b-allow', effect: 'allow', match: { commandPrefix: ['bun', 'run', 'build'] } }] }))
  write(join(ws, PROJECT_DIR_NAME, 'agents', 'rev.md'), '---\ndescription: project reviewer\ntools: [file.read, shell.start]\n---\nreview harder\n')
  // The person's own wider agent and server of the same names.
  write(join(dataDir, 'harness', 'agents', 'rev.md'), '---\ndescription: reviewer\ntools: [file.read]\n---\nreview\n')
  write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({ mcpServers: { db: { type: 'stdio', command: ['my-db'] } } }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'catalogue-trust-'))
  home = join(root, 'home')
  dataDir = join(home, '.agentistics')
  ws = join(root, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('criterion 1 — an untrusted project has no power, and each part says why', () => {
  test('allow, profile, MCP server, after-edit step and the widening agent parts are inert; deny/ask apply', async () => {
    writeProject()
    const view = await load()
    expect(view.trust.state).toBe('untrusted')
    const s = view.settings.find(x => x.scope === 'project')!
    expect(s.settings.rules!.map(r => r.id)).toEqual(['p-deny', 'p-ask'])
    expect(s.settings.profile).toBeUndefined()
    expect(s.inert.map(i => [i.what, i.code])).toEqual([['p-allow', 'catalogue.needs-trust'], ['profile', 'catalogue.needs-trust']])
    const db = find(view.items, 'mcpServer', 'db')
    expect(db.map(i => [i.entry.scope, i.status])).toEqual([['user', 'active'], ['project', 'inert']])
    const step = view.items.find(i => i.entry.kind === 'afterEdit')!
    expect(step.status).toBe('inert')
    expect(step.inert[0]!.en).toContain('not run until the project is trusted')
    expect(find(view.items, 'agent', 'rev', 'project')[0]!.inert.map(i => i.what)).toEqual(['shell.start'])
    const profile = find(view.items, 'permissionProfile', 'build', 'project')[0]!
    expect(profile.inert.map(i => i.what)).toEqual(['b-allow'])
    // commands are text: loaded untrusted
    expect(find(view.items, 'command', 'ship')[0]!.status).toBe('active')
  })

  test('a repository cannot trust itself: a trust flag in its settings is REFUSED as an unknown key', async () => {
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({ trusted: true, rules: [{ id: 'a', effect: 'allow', match: { commandPrefix: ['make'] } }] }))
    const view = await load()
    expect(view.trust.state).toBe('untrusted')
    const s = view.settings.find(x => x.scope === 'project')!
    expect(s.problems.length).toBeGreaterThan(0)
    expect(s.settings.rules ?? []).toEqual([])
  })
})

describe('trust makes the widening real', () => {
  test('after `agentop code trust`, every part applies and the entries say trusted', async () => {
    writeProject()
    const r = await trust()
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Trusted ${ws}`)
    expect(r.out).toContain('the MCP server "db"')
    expect(r.out).toContain('the allow rule "p-allow"')
    const view = await load()
    expect(view.trust.state).toBe('trusted')
    const s = view.settings.find(x => x.scope === 'project')!
    expect(s.settings.rules!.map(r => r.id)).toEqual(['p-deny', 'p-ask', 'p-allow'])
    expect(s.settings.profile).toBe('build')
    expect(s.inert).toEqual([])
    const db = find(view.items, 'mcpServer', 'db')
    expect(db.map(i => [i.entry.scope, i.status, i.entry.trust])).toEqual([['project', 'active', 'trusted'], ['user', 'shadowed', 'n/a']])
    expect(view.items.find(i => i.entry.kind === 'afterEdit')!.status).toBe('active')
    expect(find(view.items, 'agent', 'rev', 'project')[0]!.inert).toEqual([])
    expect(find(view.items, 'permissionProfile', 'build', 'project')[0]!.inert).toEqual([])
  })

  test('the grants file is 0600 under a 0700 runtime directory, keyed by the root\'s realpath', async () => {
    writeProject()
    await trust()
    expect(statSync(grantsPath(dataDir)).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'runtime')).mode & 0o777).toBe(0o700)
    const file = JSON.parse(readFileSync(grantsPath(dataDir), 'utf-8'))
    expect(Object.keys(file.projects)).toEqual([ws])
    expect(file.projects[ws].trust.trustedAt).toBe(NOW.toISOString())
  })

  test('trust is recorded for the WORKSPACE ROOT when given a folder inside it', async () => {
    writeProject()
    Bun.spawnSync(['git', 'init', '-q', ws], { env: gitTestEnv() })
    mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
    const r = await trust(join(ws, 'src', 'deep'))
    expect(r.code).toBe(0)
    expect(r.out).toContain(`is inside the workspace ${ws}`)
    expect((await load()).trust.state).toBe('trusted')
  })

  test('trusting twice changes nothing and says so', async () => {
    writeProject()
    await trust()
    const r = await trust()
    expect(r.out).toContain('already trusted')
    expect(auditLines().filter(a => a.action === 'harness.trust')).toHaveLength(1)
  })
})

describe('criterion 2 — a changed power-granting subset re-asks; text does not', () => {
  test('editing a command\'s text keeps the trust', async () => {
    writeProject()
    await trust()
    write(join(ws, PROJECT_DIR_NAME, 'commands', 'ship.md'), '---\ndescription: ship everything\n---\nShip it all now: $ARGUMENTS\n')
    write(join(ws, PROJECT_DIR_NAME, 'commands', 'fresh.md'), '---\ndescription: new\n---\nhello\n')
    expect((await load()).trust.state).toBe('trusted')
  })

  test('a git pull adding an MCP server drops the trust, names the change, clears the record and audits it', async () => {
    writeProject()
    await trust()
    writeProject({ mcpServers: { extra: { type: 'stdio', command: ['bunx', 'surprise-mcp'] } } })
    const view = await load()
    expect(view.trust.state).toBe('dropped')
    const n = view.notices.find(x => x.code === 'catalogue.trust-dropped')!
    expect(n.en).toContain('added the MCP server "extra"')
    expect(n.en).toContain('untrusted again')
    // …and the project is treated as untrusted on that very load
    expect(find(view.items, 'mcpServer', 'extra')[0]!.status).toBe('inert')
    expect(view.settings.find(x => x.scope === 'project')!.settings.profile).toBeUndefined()
    // cleared on disk: reverting the change does NOT bring the old trust back
    expect(JSON.parse(readFileSync(grantsPath(dataDir), 'utf-8')).projects).toEqual({})
    writeProject()
    expect((await load()).trust.state).toBe('untrusted')
    const dropped = auditLines().find(a => a.action === 'harness.trust_dropped')!
    expect(dropped.targetId).toBe(ws)
    expect(dropped.meta.added).toEqual(['mcpServer:extra'])
  })

  test('untrust then trust: nothing the first trust earned survives (server approvals included)', async () => {
    writeProject()
    await trust()
    // B6.3 remembers a server approval inside the project's record.
    const file = JSON.parse(readFileSync(grantsPath(dataDir), 'utf-8'))
    file.projects[ws].servers = { db: { declaration: 'a'.repeat(64), approvedAt: NOW.toISOString() } }
    writeFileSync(grantsPath(dataDir), JSON.stringify(file))
    const u = await untrust()
    expect(u.code).toBe(0)
    expect(u.out).toContain('Cleared: the folder\'s trust.')
    expect(u.out).toContain('remembered MCP server approvals (db)')
    expect((await load()).trust.state).toBe('untrusted')
    await trust()
    const after = JSON.parse(readFileSync(grantsPath(dataDir), 'utf-8'))
    expect(after.projects[ws].servers).toBeUndefined()
    const un = auditLines().find(a => a.action === 'harness.untrust')!
    expect(un.meta).toEqual({ root: ws, clearedTrust: true, clearedServers: ['db'] })
  })

  test('untrust of a folder that was never trusted clears nothing and writes no audit', async () => {
    const u = await untrust()
    expect(u.out).toContain('was not trusted')
    expect(auditLines()).toEqual([])
  })

  test('untrust still finds the record of a folder that has since been deleted', async () => {
    writeProject()
    await trust()
    rmSync(ws, { recursive: true, force: true })
    const u = await untrust()
    expect(u.out).toContain(`Untrusted ${ws}`)
  })
})

describe('trust never lifts the floor or a user deny', () => {
  test('a trusted project\'s allow rules over floor subjects are refused in words, never applied', async () => {
    const floorRules = [
      { id: 'git', effect: 'allow', match: { action: 'write', pathGlob: '.git/**' } },
      { id: 'ssh', effect: 'allow', match: { pathGlob: '~/.ssh/**' } },
      { id: 'data', effect: 'allow', match: { action: 'read', pathGlob: `${dataDir}/**` } },
      { id: 'prot', effect: 'allow', match: { action: 'write', pathGlob: '/srv/prod/**' } },
      { id: 'force', effect: 'allow', match: { commandPrefix: ['git', 'push', '--force'] } },
      { id: 'mkfs', effect: 'allow', match: { commandPrefix: ['mkfs.ext4'] } },
    ]
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({ rules: [...floorRules, { id: 'ok', effect: 'allow', match: { commandPrefix: ['make'] } }] }))
    // The machine's floor is part of what is hashed: trust and load under the SAME one.
    await trust(ws, { load: o => loadCatalogue({ ...opts({ protectedPaths: ['/srv/prod/**'] }), ...o }) })
    const view = await load({ protectedPaths: ['/srv/prod/**'] })
    expect(view.trust.state).toBe('trusted')
    const s = view.settings.find(x => x.scope === 'project')!
    expect(s.settings.rules!.map(r => r.id)).toEqual(['ok'])
    const refused = s.problems.filter(p => p.code === 'catalogue.rule-floor')
    expect(refused.length).toBe(floorRules.length)
    for (const r of floorRules) expect(refused.some(p => p.en.includes(`"${r.id}"`) || p.en.includes(r.id))).toBe(true)
  })

  test('a user deny beats a trusted project\'s allow for the same command', async () => {
    write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({ rules: [{ id: 'u-no-deploy', effect: 'deny', match: { commandPrefix: ['make', 'deploy'] } }] }))
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({ rules: [
      { id: 'p-make', effect: 'allow', match: { commandPrefix: ['make'] } },
      { id: 'p-deploy', effect: 'allow', match: { commandPrefix: ['make', 'deploy'] } },
    ] }))
    await trust(ws)
    const view = await load()
    const layers: PolicyLayer[] = ['user', 'project'].map(scope => ({ name: scope, rules: view.settings.find(x => x.scope === scope)!.settings.rules ?? [] }))
    const target = (argv: string[]): RuleTarget => ({ action: 'shell', tool: 'shell.start', path: ws, anyStages: [argv], allowStages: [argv] })
    const env = { home, workspaceRoot: ws }
    expect(decideByRules(layers, target(['make', 'deploy', 'prod']), env)?.rule.id).toBe('u-no-deploy')
    // …and the trusted allow IS in force where no deny speaks
    expect(decideByRules(layers, target(['make', 'build']), env)?.rule.id).toBe('p-make')
  })
})

describe('a corrupt grants file = nothing trusted', () => {
  test('a trusted project reads untrusted with a notice; the next trust moves the bad file aside', async () => {
    writeProject()
    await trust()
    writeFileSync(grantsPath(dataDir), '{"version":1,"projects":{"' + ws + '":{"trust":{"trustedAt":"x"')
    const view = await load()
    expect(view.trust.state).toBe('untrusted')
    expect(view.notices.map(n => n.code)).toContain('catalogue.grants-corrupt')
    expect(find(view.items, 'mcpServer', 'db', 'project')[0]!.status).toBe('inert')
    const r = await trust()
    expect(r.out).toContain('moved aside')
    expect(readdirSync(join(dataDir, 'runtime')).some(f => f.startsWith('harness-grants.json.corrupt-'))).toBe(true)
    expect((await load()).trust.state).toBe('trusted')
  })

  test('a file that trusts with a malformed record trusts NOTHING, not the records that look fine', async () => {
    writeProject()
    await trust()
    const file = JSON.parse(readFileSync(grantsPath(dataDir), 'utf-8'))
    file.projects['/elsewhere'] = { trust: { trustedAt: NOW.toISOString(), grants: 'nope', parts: {} } }
    writeFileSync(grantsPath(dataDir), JSON.stringify(file))
    expect((await load()).trust.state).toBe('untrusted')
  })
})

describe('the CLI door', () => {
  test('refused on a central, in words, before anything is written', async () => {
    writeProject()
    const r = await trust(ws, { isCentral: async () => true })
    expect(r.code).toBe(1)
    expect(r.err).toContain('central')
    expect(existsSync(grantsPath(dataDir))).toBe(false)
  })

  test('needs exactly one folder, which must exist', async () => {
    const h = cli()
    expect(await runTrust('trust', [], h.deps)).toBe(2)
    expect(h.err()).toContain('needs a folder')
    expect((await trust(join(root, 'missing'))).code).toBe(1)
  })

  test('a workspace whose .agentistics is the data directory has nothing to trust', async () => {
    const r = await trust(home, { load: o => loadCatalogue({ ...opts({ workspaceRoot: home, cwd: home }), ...o }) })
    expect(r.code).toBe(1)
    expect(r.err).toContain('own data directory')
  })

  test('`agentop code trust` dispatches without the provider flag', async () => {
    const lines: string[] = []
    const code = await runCode(['trust', '--help'], { stdout: (l: string) => lines.push(l), stderr: (l: string) => lines.push(l), flagOn: () => false } as never)
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('agentop code trust <dir>')
  })

  test('the audit names what was granted and never a declaration', async () => {
    writeProject()
    await trust()
    const raw = readFileSync(grantsAuditPath(dataDir), 'utf-8')
    expect(statSync(grantsAuditPath(dataDir)).mode & 0o777).toBe(0o600)
    const a = auditLines().find(x => x.action === 'harness.trust')!
    expect(a.meta.granted).toEqual(expect.arrayContaining(['mcpServer:db', 'rule:p-allow', 'profile', 'agent:rev', 'permissionProfile:build']))
    expect(raw).not.toContain('project-db-mcp')
    expect(raw).not.toContain('biome')
  })
})
