import { describe, expect, test } from 'bun:test'
import type { CatalogueEntry } from '@agentistics/runtime'
import type { CatalogueItem } from './catalogue-plan.ts'
import type { LoadedCatalogue } from './catalogue-host.ts'
import { runCatalogue, type CatalogueCliDeps } from './cli-catalogue.ts'
import type { CliLang } from './cli-i18n.ts'

const SECRET = 'sk-live-SUPERSECRETVALUE'

const cmd: CatalogueEntry<'command'> = {
  kind: 'command', name: 'ship', scope: 'user', source: { path: '/u/harness/commands/ship.md' }, enabled: true, trust: 'n/a', problems: [],
  def: { description: 'Ship it', args: '<env>', template: 'Deploy to $1\nthen verify' },
}
const broken: CatalogueEntry<'skill'> = {
  kind: 'skill', name: 'oops', scope: 'project', source: { path: '/w/.agentistics/skills/oops/SKILL.md' }, enabled: false, trust: 'untrusted',
  problems: [{ code: 'catalogue.x', path: '/w/.agentistics/skills/oops/SKILL.md', line: 3, en: 'description is missing.', pt: 'a descrição está faltando.' }],
  def: { description: '', body: 'body text' },
}
const mcp: CatalogueEntry<'mcpServer'> = {
  kind: 'mcpServer', name: 'db', scope: 'project', source: { path: '/w/.agentistics/settings.json' }, enabled: true, trust: 'untrusted', problems: [],
  def: { type: 'http', url: 'https://db.example/mcp', headers: { Authorization: SECRET }, auth: { credential: 'cred-1' } },
}
const shadowedCmd: CatalogueEntry<'command'> = {
  ...cmd, name: 'ship', scope: 'compat', source: {}, def: { description: 'older', template: 't' },
}
const overriding: CatalogueEntry<'command'> = { ...cmd, shadows: { scope: 'builtin' } }

const items: CatalogueItem[] = [
  { entry: overriding, status: 'active', inert: [], backup: { excluded: 'secret', en: 'a backup does not carry this file.', pt: 'um backup não leva este arquivo.' } },
  { entry: broken, status: 'disabled', inert: [] },
  { entry: mcp, status: 'inert', inert: [{ what: 'db', code: 'catalogue.needs-trust', en: 'not started until trusted.', pt: 'não inicia até ser confiável.' }] },
  { entry: shadowedCmd, status: 'shadowed', inert: [] },
]

const catalogue: LoadedCatalogue = {
  items,
  settings: [{
    scope: 'user', path: '/u/harness/settings.json', settings: { rules: [{ id: 'deny-rm', effect: 'deny', match: {} } as never] },
    inert: [{ what: 'profile', code: 'c', en: 'profile ignored.', pt: 'perfil ignorado.' }], problems: [], secretNarrowed: false,
  }],
  notices: [{ scope: 'user', path: '/u/harness/junk.txt', code: 'catalogue.unrecognised-file', en: 'not read.', pt: 'não lido.' }],
  roots: { workspaceRoot: '/w', user: '/u/harness', project: '/w/.agentistics', compat: [] },
  floorEnv: {} as never,
  trust: { state: 'untrusted', key: '/w', corrupt: false },
  grants: { hash: '0'.repeat(64), parts: {} },
}

function harness(over: Partial<CatalogueCliDeps> = {}, lang: CliLang = 'en') {
  const out: string[] = []
  const err: string[] = []
  let loads = 0
  const deps: Partial<CatalogueCliDeps> = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    load: async () => { loads++; return catalogue },
    isCentral: async () => false,
    lang: async () => lang,
    cwd: '/w',
    ...over,
  }
  return { deps, out: () => out.join('\n'), err: () => err.join('\n'), loads: () => loads }
}

describe('agentop catalogue ls', () => {
  test('prints every item with its status and its problem sentence', async () => {
    const h = harness()
    expect(await runCatalogue(['ls'], h.deps)).toBe(0)
    const o = h.out()
    expect(o).toContain('Workspace root: /w')
    expect(o).toMatch(/skill\s+oops\s+project\s+disabled/)
    expect(o).toContain('/w/.agentistics/skills/oops/SKILL.md:3: description is missing.')
    expect(o).toMatch(/mcpServer\s+db\s+project\s+inert/)
    expect(o).toContain('db: not started until trusted.')
    expect(o).toContain('overrides the builtin one at builtin')
    expect(o).toContain('backup: a backup does not carry this file.')
    expect(o).toContain('deny deny-rm')
    expect(o).toContain('/u/harness/junk.txt: not read.')
    expect(o).toContain('4 item(s): 1 active, 1 disabled, 1 shadowed, 1 inert')
  })

  test('--kind and --scope filter items', async () => {
    const a = harness()
    await runCatalogue(['ls', '--kind', 'skill'], a.deps)
    expect(a.out()).toContain('oops')
    expect(a.out()).not.toContain('ship')
    const b = harness()
    await runCatalogue(['ls', '--scope', 'compat'], b.deps)
    expect(b.out()).toContain('ship')
    expect(b.out()).not.toContain('oops')
    expect(b.out()).not.toContain('deny-rm')
  })

  test('--problems keeps disabled, inert and backup-noted items plus problem settings and notices', async () => {
    const h = harness()
    await runCatalogue(['ls', '--problems'], h.deps)
    const o = h.out()
    expect(o).toContain('oops')
    expect(o).toContain('db')
    expect(o).toContain('backup does not carry')
    expect(o).toContain('profile ignored.')
    expect(o).toContain('junk.txt')
    expect(o).not.toContain('older')
    expect(o).toContain('3 item(s): 1 active, 1 disabled, 0 shadowed, 1 inert')
  })

  test('--json parses and never carries header values', async () => {
    const h = harness()
    expect(await runCatalogue(['ls', '--json'], h.deps)).toBe(0)
    const parsed = JSON.parse(h.out())
    expect(parsed.items).toHaveLength(4)
    expect(h.out()).not.toContain(SECRET)
  })

  test('an empty filter result prints a sentence', async () => {
    const h = harness()
    await runCatalogue(['ls', '--kind', 'agent'], h.deps)
    expect(h.out()).toContain('Nothing matches those filters.')
  })

  test('pt language prints Portuguese chrome and sentences', async () => {
    const h = harness({}, 'pt')
    await runCatalogue(['ls'], h.deps)
    const o = h.out()
    expect(o).toContain('Raiz do workspace: /w')
    expect(o).toMatch(/desativado/)
    expect(o).toContain('a descrição está faltando.')
    expect(o).toContain('sobrepõe o do escopo builtin')
    expect(o).toContain('4 item(ns)')
  })
})

describe('agentop catalogue show', () => {
  test('prints the definition, and only the KEYS of mcp headers', async () => {
    const h = harness()
    expect(await runCatalogue(['show', 'mcpServer', 'db'], h.deps)).toBe(0)
    const o = h.out()
    expect(o).toContain('type: http')
    expect(o).toContain('url: https://db.example/mcp')
    expect(o).toContain('header keys: Authorization')
    expect(o).toContain('auth credential: cred-1')
    expect(o).not.toContain(SECRET)
  })

  test('command shows its template in full; --scope narrows to one match', async () => {
    const h = harness()
    await runCatalogue(['show', 'command', 'ship', '--scope', 'user'], h.deps)
    expect(h.out()).toContain('  Deploy to $1')
    expect(h.out()).toContain('  then verify')
    expect(h.out()).not.toContain('older')
    const all = harness()
    await runCatalogue(['show', 'command', 'ship'], all.deps)
    expect(all.out()).toContain('scope: user')
    expect(all.out()).toContain('scope: compat')
  })

  test('show --json prints the matching items', async () => {
    const h = harness()
    await runCatalogue(['show', 'skill', 'oops', '--json'], h.deps)
    const parsed = JSON.parse(h.out())
    expect(parsed).toHaveLength(1)
    expect(parsed[0].entry.name).toBe('oops')
  })

  test('an unknown name says so and exits 1', async () => {
    const h = harness()
    expect(await runCatalogue(['show', 'agent', 'nope'], h.deps)).toBe(1)
    expect(h.err()).toContain('No agent named "nope"')
  })
})

describe('agentop catalogue: refusals and usage', () => {
  test('a central refuses without loading', async () => {
    const h = harness({ isCentral: async () => true })
    expect(await runCatalogue(['ls'], h.deps)).toBe(1)
    expect(h.loads()).toBe(0)
    expect(h.err()).toContain('central runs none')
  })

  test('no verb and help print usage with exit 0', async () => {
    for (const a of [[], ['help'], ['--help']]) {
      const h = harness()
      expect(await runCatalogue(a, h.deps)).toBe(0)
      expect(h.out()).toContain('agentop catalogue ls')
      expect(h.loads()).toBe(0)
    }
  })

  test('bad kind, bad scope, unknown flag, unknown verb and missing args exit 2', async () => {
    for (const a of [['ls', '--kind', 'bogus'], ['ls', '--scope', 'bogus'], ['ls', '--nope'], ['zap'], ['show', 'command'], ['show', 'bogus', 'x']]) {
      const h = harness()
      expect(await runCatalogue(a, h.deps)).toBe(2)
      expect(h.err()).toContain('agentop catalogue ls')
      expect(h.loads()).toBe(0)
    }
  })
})

describe('agentop catalogue: literal secrets in kept rules', () => {
  const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
  const leaky: LoadedCatalogue = {
    ...catalogue,
    items: [
      ...items,
      {
        entry: {
          kind: 'permissionProfile', name: 'strict', scope: 'user', source: { path: '/u/harness/profiles/strict.json' }, enabled: true, trust: 'n/a', problems: [],
          def: { rules: [{ id: 'deny-key', effect: 'deny', match: { pathGlob: KEY } }] },
        } as CatalogueEntry,
        status: 'active', inert: [],
      },
      { entry: { ...cmd, name: 'leaky', def: { description: 'd', template: `curl -H "x: ${KEY}"` } } as CatalogueEntry, status: 'active', inert: [] },
    ],
    settings: [{
      scope: 'user', path: '/u/harness/settings.json', settings: { rules: [{ id: 'deny-key', effect: 'deny', match: { pathGlob: KEY } }] },
      inert: [], problems: [], secretNarrowed: true,
    }],
  }

  test('ls, ls --json and show never print it', async () => {
    for (const a of [['ls'], ['ls', '--json'], ['show', 'permissionProfile', 'strict'], ['show', 'permissionProfile', 'strict', '--json'], ['show', 'command', 'leaky']]) {
      const h = harness({ load: async () => leaky })
      expect(await runCatalogue(a, h.deps)).toBe(0)
      expect(h.out()).not.toContain(KEY)
      expect(h.out().length).toBeGreaterThan(0)
    }
  })

  test('the settings section shows the rule match, redacted', async () => {
    const h = harness({ load: async () => leaky })
    await runCatalogue(['ls'], h.deps)
    expect(h.out()).toContain('deny deny-key {"pathGlob":')
  })
})
