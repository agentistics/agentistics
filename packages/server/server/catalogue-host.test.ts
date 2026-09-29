/**
 * catalogue-host.test.ts — the loader against real directories (an isolated temp HOME and data dir,
 * never `~/.agentistics`), plus the planner's two host rules: the file-level secret (leader
 * decision 8) and the untrusted project (criterion 1).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePermissionProfileFile, SYMBOLIC_FLOOR_ENV } from '@agentistics/runtime'
import { loadCatalogue, PROJECT_DIR_NAME, type LoadCatalogueOptions } from './catalogue-host'
import type { CatalogueItem } from './catalogue-plan'
import { HARNESS_ORDER } from '@agentistics/core'
import { BACKUP_LAYERS, excludeFor, planSources } from './backup/backup-plan'

let root = ''
let home = ''
let dataDir = ''
let ws = ''

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function opts(extra: Partial<LoadCatalogueOptions> = {}): LoadCatalogueOptions {
  return { home, dataDir, defaultDataDir: join(home, '.agentistics'), workspaceRoot: ws, cwd: ws, protectedPaths: [], ...extra }
}

function find(items: CatalogueItem[], kind: string, name: string, scope?: string): CatalogueItem[] {
  return items.filter(i => i.entry.kind === kind && i.entry.name === name && (scope === undefined || i.entry.scope === scope))
}

const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
const skill = (name: string, description = 'does a thing'): string => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`
const command = (description: string): string => `---\ndescription: ${description}\n---\nDo $ARGUMENTS\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'catalogue-host-'))
  home = join(root, 'home')
  dataDir = join(home, '.agentistics')
  ws = join(root, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('scopes', () => {
  test('reads user and project scopes and resolves precedence, with the shadow said', async () => {
    write(join(dataDir, 'harness', 'commands', 'review.md'), command('user review'))
    write(join(ws, PROJECT_DIR_NAME, 'commands', 'review.md'), command('project review'))
    const view = await loadCatalogue(opts())
    const rows = find(view.items, 'command', 'review')
    expect(rows.map(r => [r.entry.scope, r.status])).toEqual([['project', 'active'], ['user', 'shadowed']])
    expect(rows[0]!.entry.shadows).toEqual({ scope: 'user', path: join(dataDir, 'harness', 'commands', 'review.md') })
    expect(view.roots.project).toBe(join(ws, PROJECT_DIR_NAME))
  })

  test('an invalid entry is listed DISABLED with a file:line sentence, never dropped (criterion 4)', async () => {
    write(join(dataDir, 'harness', 'agents', 'helper.md'), '---\ndescripton: typo\n---\nprompt\n')
    const view = await loadCatalogue(opts())
    const [row] = find(view.items, 'agent', 'helper')
    expect(row!.status).toBe('disabled')
    const codes = row!.entry.problems.map(p => p.code)
    expect(codes).toContain('catalogue.unknown-key')
    expect(row!.entry.problems.find(p => p.code === 'catalogue.unknown-key')!.line).toBe(2)
  })

  test('a skill directory without SKILL.md is listed, disabled, with its sentence', async () => {
    mkdirSync(join(dataDir, 'harness', 'skills', 'empty'), { recursive: true })
    const [row] = find((await loadCatalogue(opts())).items, 'skill', 'empty')
    expect(row!.status).toBe('disabled')
    expect(row!.entry.problems[0]!.code).toBe('catalogue.skill-missing')
  })

  test('an unrecognised file is a notice, not silence; reserved names are not', async () => {
    write(join(dataDir, 'harness', 'notes.txt'), 'x')
    write(join(dataDir, 'harness', 'commands', 'readme.txt'), 'x')
    mkdirSync(join(dataDir, 'harness', 'orchestrations'), { recursive: true })
    mkdirSync(join(dataDir, 'harness', 'artifacts'), { recursive: true })
    const view = await loadCatalogue(opts())
    expect(view.notices.map(n => n.path)).toEqual([
      join(dataDir, 'harness', 'commands', 'readme.txt'),
      join(dataDir, 'harness', 'notes.txt'),
    ])
  })

  test('the result does not depend on the order files were created (sorted, asserted)', async () => {
    for (const n of ['zeta', 'alpha', 'mid']) write(join(dataDir, 'harness', 'commands', `${n}.md`), command(n))
    const names = (await loadCatalogue(opts())).items.filter(i => i.entry.kind === 'command' && i.entry.scope === 'user').map(i => i.entry.name)
    expect(names).toEqual(['alpha', 'mid', 'zeta'])
  })

  test('a project may not redefine a built-in command (/exit)', async () => {
    write(join(ws, PROJECT_DIR_NAME, 'commands', 'exit.md'), command('not really'))
    const rows = find((await loadCatalogue(opts())).items, 'command', 'exit')
    expect(rows.find(r => r.entry.scope === 'builtin')!.status).toBe('active')
    const proj = rows.find(r => r.entry.scope === 'project')!
    expect(proj.status).toBe('disabled')
    expect(proj.entry.problems.map(p => p.code)).toContain('catalogue.builtin-shadow-refused')
  })
})

describe('what the host refuses to read', () => {
  test('a project file symlinked OUTSIDE the project is listed disabled and never read', async () => {
    const secretFile = join(home, '.aws', 'credentials')
    write(secretFile, '---\ndescription: stolen\n---\naws_secret_access_key=abc\n')
    mkdirSync(join(ws, PROJECT_DIR_NAME, 'commands'), { recursive: true })
    symlinkSync(secretFile, join(ws, PROJECT_DIR_NAME, 'commands', 'leak.md'))
    const [row] = find((await loadCatalogue(opts())).items, 'command', 'leak')
    expect(row!.status).toBe('disabled')
    expect(row!.entry.problems[0]!.code).toBe('catalogue.outside-project')
    expect(row!.entry.def).toBeUndefined()
    expect(JSON.stringify(row)).not.toContain('aws_secret_access_key')
  })

  test('a workspace whose .agentistics IS the data directory is not read as a project', async () => {
    write(join(dataDir, 'harness', 'commands', 'mine.md'), command('mine'))
    const view = await loadCatalogue(opts({ workspaceRoot: home, cwd: home }))
    expect(view.roots.project).toBeNull()
    expect(view.notices.map(n => n.code)).toContain('catalogue.project-is-data-dir')
    expect(find(view.items, 'command', 'mine').map(r => r.entry.scope)).toEqual(['user'])
  })

  test('a file over the size ceiling is listed disabled', async () => {
    write(join(dataDir, 'harness', 'commands', 'big.md'), command('big') + 'x'.repeat(300 * 1024))
    const [row] = find((await loadCatalogue(opts())).items, 'command', 'big')
    expect(row!.entry.problems[0]!.code).toBe('catalogue.too-large')
  })
})

describe('compat is the person\'s opt-in, in USER settings only', () => {
  const compatDirs = (): { claudeSkills: string; agentsSkills: string } => ({ claudeSkills: join(home, '.claude', 'skills'), agentsSkills: join(home, '.agents', 'skills') })
  beforeEach(() => {
    write(join(home, '.claude', 'skills', 'graph', 'SKILL.md'), skill('graph'))
    write(join(home, '.agents', 'skills', 'other', 'SKILL.md'), skill('other'))
  })

  test('not read by default', async () => {
    const view = await loadCatalogue(opts({ compatDirs: compatDirs() }))
    expect(view.items.filter(i => i.entry.scope === 'compat')).toEqual([])
    expect(view.roots.compat).toEqual([])
  })

  test('read when the user settings opt in, and only the directory opted into', async () => {
    write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({ compat: { claudeSkills: true } }))
    const view = await loadCatalogue(opts({ compatDirs: compatDirs() }))
    expect(view.items.filter(i => i.entry.scope === 'compat').map(i => i.entry.name)).toEqual(['graph'])
  })

  test('a project cannot opt the person in', async () => {
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({ compat: { claudeSkills: true } }))
    const view = await loadCatalogue(opts({ compatDirs: compatDirs() }))
    expect(view.items.filter(i => i.entry.scope === 'compat')).toEqual([])
    expect(view.settings.find(s => s.scope === 'project')!.problems.map(p => p.code)).toContain('catalogue.compat-scope')
  })

  test('an opt-in written in a file carrying a literal secret is ignored (decision 8)', async () => {
    write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({
      compat: { claudeSkills: true },
      rules: [{ id: 'oops', effect: 'deny', match: { pathGlob: SECRET } }],
    }))
    const view = await loadCatalogue(opts({ compatDirs: compatDirs() }))
    expect(view.items.filter(i => i.entry.scope === 'compat')).toEqual([])
  })
})

describe('decision 8 — a file-level secret keeps the restrictions and drops the widening', () => {
  test('deny/ask kept; allow, profile, defaultModel, servers and steps ignored; the file is named; the secret is never echoed', async () => {
    const settingsPath = join(dataDir, 'harness', 'settings.json')
    write(settingsPath, JSON.stringify({
      defaultModel: { provider: 'anthropic', model: 'claude-sonnet-5' },
      profile: 'relaxed',
      rules: [
        { id: 'no-env', effect: 'deny', match: { pathGlob: '**/.env.local' } },
        { id: 'ask-push', effect: 'ask', match: { commandPrefix: ['git', 'push'] } },
        { id: 'let-bun', effect: 'allow', match: { commandPrefix: ['bun', 'test'] } },
        { id: 'leaky', effect: 'deny', match: { pathGlob: SECRET } },
      ],
      mcpServers: { db: { type: 'stdio', command: ['bunx', 'db-mcp'] } },
      afterEdit: [{ name: 'fmt', match: '**/*.ts', run: ['bunx', 'biome', 'format', '{path}'] }],
      skills: { budgetTokens: 900 },
    }, null, 2))
    const view = await loadCatalogue(opts())
    const s = view.settings.find(x => x.scope === 'user')!
    expect(s.secretNarrowed).toBe(true)
    expect(s.settings.rules!.map(r => r.id)).toEqual(['no-env', 'ask-push', 'leaky'])
    expect(s.settings.profile).toBeUndefined()
    expect(s.settings.defaultModel).toBeUndefined()
    expect(s.settings.skills).toEqual({ budgetTokens: 900 })
    expect(s.inert.map(i => i.what).sort()).toEqual(['defaultModel', 'let-bun', 'profile'])
    for (const i of s.inert) expect(i.en).toContain(settingsPath)
    expect(s.problems.map(p => p.code)).toContain('catalogue.literal-secret')
    for (const kind of ['mcpServer', 'afterEdit']) {
      const [row] = view.items.filter(i => i.entry.kind === kind)
      expect(row!.status).toBe('disabled')
      expect(row!.entry.problems.map(p => p.code)).toContain('catalogue.file-secret-widening')
    }
    // No SENTENCE echoes the value. The deny rule that carries it stays IN FORCE (decision 8), so
    // its match is still data here; the CLI is the surface that must redact it when printing.
    const sentences = [...view.items.flatMap(i => [...i.entry.problems, ...i.inert]), ...s.problems, ...s.inert]
    expect(sentences.length).toBeGreaterThan(0)
    for (const x of sentences) { expect(x.en).not.toContain(SECRET); expect(x.pt).not.toContain(SECRET) }
    for (const x of s.inert) expect(x.pt).not.toMatch(/the allow rule|the starting profile/)
  })

  test('a file with no secret keeps its own allows (user scope is the person\'s act)', async () => {
    write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({ rules: [{ id: 'let-bun', effect: 'allow', match: { commandPrefix: ['bun', 'test'] } }] }))
    const s = (await loadCatalogue(opts())).settings.find(x => x.scope === 'user')!
    expect(s.secretNarrowed).toBe(false)
    expect(s.settings.rules!.map(r => r.id)).toEqual(['let-bun'])
    expect(s.inert).toEqual([])
  })
})

describe('an untrusted project has no power (criterion 1)', () => {
  test('allow rule and profile inert with sentences; deny/ask applied', async () => {
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({
      profile: 'accept-edits',
      rules: [
        { id: 'p-deny', effect: 'deny', match: { pathGlob: 'secrets/**' } },
        { id: 'p-allow', effect: 'allow', match: { commandPrefix: ['make'] } },
      ],
    }))
    const s = (await loadCatalogue(opts())).settings.find(x => x.scope === 'project')!
    expect(s.settings.rules!.map(r => r.id)).toEqual(['p-deny'])
    expect(s.settings.profile).toBeUndefined()
    expect(s.inert.map(i => [i.what, i.code])).toEqual([['p-allow', 'catalogue.needs-trust'], ['profile', 'catalogue.needs-trust']])
  })

  test('a project MCP server and after-edit step are inert and do NOT shadow the person\'s own server', async () => {
    write(join(dataDir, 'harness', 'settings.json'), JSON.stringify({ mcpServers: { db: { type: 'stdio', command: ['my-db'] } } }))
    write(join(ws, PROJECT_DIR_NAME, 'settings.json'), JSON.stringify({
      mcpServers: { db: { type: 'stdio', command: ['evil-db'] }, extra: { type: 'http', url: 'https://mcp.example.com' } },
      afterEdit: [{ match: '**/*', run: ['curl', 'x'] }],
    }))
    const view = await loadCatalogue(opts())
    const db = find(view.items, 'mcpServer', 'db')
    expect(db.map(r => [r.entry.scope, r.status])).toEqual([['user', 'active'], ['project', 'inert']])
    expect(db[0]!.entry.shadows).toBeUndefined()
    expect(db[1]!.inert[0]!.en).toContain('replacing the user one')
    expect(find(view.items, 'mcpServer', 'extra')[0]!.status).toBe('inert')
    const step = view.items.find(i => i.entry.kind === 'afterEdit')!
    expect(step.status).toBe('inert')
    expect(step.inert[0]!.en).toContain('not run until the project is trusted')
  })

  test('a project agent keeps its narrowing and names what it may not widen', async () => {
    write(join(dataDir, 'harness', 'agents', 'rev.md'), '---\ndescription: reviewer\ntools: [file.read]\n---\nreview\n')
    write(join(ws, PROJECT_DIR_NAME, 'agents', 'rev.md'), '---\ndescription: project reviewer\ntools: [file.read, shell.start]\npermissionProfile: accept-edits\n---\nreview harder\n')
    const [row] = find((await loadCatalogue(opts())).items, 'agent', 'rev', 'project')
    expect(row!.status).toBe('active')
    expect(row!.inert.map(i => i.what)).toEqual(['shell.start', 'accept-edits'])
  })
})

describe('the REAL floor environment reaches the probe (leader decision b)', () => {
  test('an absolute glob under the real home is refused as floor; under the symbolic env it would not be', async () => {
    const glob = `${home}/.ssh/**`
    const profile = JSON.stringify({ rules: [{ id: 'read-keys', effect: 'allow', match: { action: 'read', pathGlob: glob } }] })
    write(join(dataDir, 'harness', 'profiles', 'keys.json'), profile)
    const view = await loadCatalogue(opts())
    expect(view.floorEnv.home).toBe(home)
    expect(view.floorEnv.workspaceRoot).toBe(ws)
    const [row] = find(view.items, 'permissionProfile', 'keys')
    expect(row!.entry.problems.map(p => p.code)).toContain('catalogue.rule-floor')
    // The same text under the symbolic fallback probes /home/user, and the rule slips through.
    const symbolic = parsePermissionProfileFile({ text: profile, path: 'p', name: 'keys', scope: 'user', floorEnv: SYMBOLIC_FLOOR_ENV })
    expect(symbolic.problems.map(p => p.code)).not.toContain('catalogue.rule-floor')
  })

  test('a RELOCATED data dir is floor too', async () => {
    const relocated = join(root, 'elsewhere', 'agentistics')
    write(join(relocated, 'harness', 'settings.json'), JSON.stringify({ rules: [{ id: 'peek', effect: 'allow', match: { action: 'read', pathGlob: `${relocated}/**` } }] }))
    const view = await loadCatalogue(opts({ dataDir: relocated }))
    expect(view.floorEnv.agentisticsDir).toBe(relocated)
    const s = view.settings.find(x => x.scope === 'user')!
    expect(s.problems.map(p => p.code)).toContain('catalogue.rule-floor')
    expect(s.settings.rules).toEqual([])
  })
})

describe('backup (spec §3.3 stated limit)', () => {
  test('a user file a backup would not carry says so', async () => {
    write(join(dataDir, 'harness', 'commands', 'deploy.key.md'), command('deploy'))
    write(join(dataDir, 'harness', 'commands', 'ok.md'), command('ok'))
    const view = await loadCatalogue(opts())
    expect(find(view.items, 'command', 'ok')[0]!.backup).toBeUndefined()
    const [odd] = find(view.items, 'command', 'deploy.key')
    expect(odd!.backup?.excluded).toBe('secret')
    expect(odd!.backup?.en).toContain('.key')
  })
})

describe('the backup decision for the user scope (spec §3.3; round-3 spec §9 row 5)', () => {
  const carried = (rel: string): boolean =>
    planSources({ layers: [...BACKUP_LAYERS], harnesses: [...HARNESS_ORDER] })
      .some(s => s.rel === rel || rel.startsWith(`${s.rel}/`))

  test('.agentistics/harness travels — and with it the orchestrations/ and artifacts/ stores beneath it', () => {
    expect(carried('.agentistics/harness')).toBe(true)
    expect(carried('.agentistics/harness/settings.json')).toBe(true)
    expect(carried('.agentistics/harness/orchestrations/x.json')).toBe(true)
    expect(carried('.agentistics/harness/artifacts/a/b.md')).toBe(true)
    // ONE row, not three: a row per sub-store would walk those files twice.
    const rows = planSources({ layers: ['metrics'], harnesses: [] }).filter(s => s.rel.startsWith('.agentistics/harness'))
    expect(rows.map(r => r.rel)).toEqual(['.agentistics/harness'])
  })

  test('the grants (trust, remembered approvals) do NOT travel: they sit under the runtime exclusion', () => {
    expect(excludeFor('.agentistics/runtime/harness-grants.json')?.reason).toBe('runtime')
  })
})
