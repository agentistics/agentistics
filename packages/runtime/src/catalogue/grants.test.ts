/**
 * grants.test.ts — the trust hash and the grants file (B8 spec §4, criterion 2), pure.
 */
import { describe, expect, test } from 'bun:test'
import {
  describePart,
  emptyGrantsFile,
  grantsManifest,
  grantTrust,
  parseGrantsFile,
  revokeProject,
  serializeGrantsFile,
  trustDecision,
  type GrantsFile,
  type GrantsInput,
} from './grants.ts'
import { parseAgentFile, parseCommandFile, parsePermissionProfileFile, parseSettingsFile, parseSkillFile } from './parse.ts'
import type { CatalogueEntry } from './types.ts'

const KEY = '/home/ana/repo'
const NOW = new Date('2026-09-29T12:00:00.000Z')

interface Project {
  settings?: Record<string, unknown>
  commands?: Record<string, string>
  skills?: Record<string, string>
  agents?: Record<string, string>
  profiles?: Record<string, unknown>
}

/** Parses a project the way the host would, into the manifest's input. */
function input(p: Project): GrantsInput {
  const entries: CatalogueEntry[] = []
  let settings: GrantsInput['settings']
  if (p.settings) {
    const r = parseSettingsFile({ text: JSON.stringify(p.settings), path: '/p/settings.json', scope: 'project' })
    settings = r.settings
    entries.push(...r.entries)
  }
  for (const [name, text] of Object.entries(p.commands ?? {})) entries.push(parseCommandFile({ text, path: `/p/commands/${name}.md`, name, scope: 'project' }))
  for (const [name, text] of Object.entries(p.skills ?? {})) entries.push(parseSkillFile({ text, path: `/p/skills/${name}/SKILL.md`, dirName: name, scope: 'project' }))
  for (const [name, text] of Object.entries(p.agents ?? {})) entries.push(parseAgentFile({ text, path: `/p/agents/${name}.md`, name, scope: 'project' }))
  for (const [name, v] of Object.entries(p.profiles ?? {})) entries.push(parsePermissionProfileFile({ text: JSON.stringify(v), path: `/p/profiles/${name}.json`, name, scope: 'project' }))
  return settings ? { settings, entries } : { entries }
}

const base: Project = {
  settings: {
    rules: [
      { id: 'no-secrets', effect: 'deny', match: { pathGlob: 'secrets/**' } },
      { id: 'make', effect: 'allow', match: { commandPrefix: ['make'] } },
    ],
    mcpServers: { db: { type: 'stdio', command: ['bunx', 'db-mcp'] } },
    afterEdit: [{ match: '**/*.ts', run: ['bunx', 'biome', 'format', '{path}'] }],
  },
  commands: { ship: '---\ndescription: ship it\n---\nShip $ARGUMENTS\n' },
  skills: { lint: '---\nname: lint\ndescription: how to lint\n---\nrun the linter\n' },
  agents: {
    rev: '---\ndescription: reviewer\ntools: [file.read]\n---\nreview carefully\n',
    plain: '---\ndescription: text only\n---\njust words\n',
  },
  profiles: { build: { rules: [{ id: 'b-allow', effect: 'allow', match: { commandPrefix: ['bun', 'run', 'build'] } }, { id: 'b-deny', effect: 'deny', match: { commandPrefix: ['bun', 'publish'] } }] } },
}

const clone = (p: Project): Project => JSON.parse(JSON.stringify(p)) as Project

describe('the manifest hashes exactly the power-granting subset', () => {
  test('the parts are named, sorted, and exclude text and restrictions', () => {
    const m = grantsManifest(input(base))
    expect(Object.keys(m.parts)).toEqual([
      'afterEdit:project-after-edit-1',
      'agent:rev',
      'mcpServer:db',
      'permissionProfile:build',
      'rule:make',
    ])
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('deterministic: the same project hashes the same, whatever the entry order', () => {
    const a = input(base)
    const b = { ...a, entries: [...a.entries].reverse() }
    expect(grantsManifest(b)).toEqual(grantsManifest(a))
  })

  const edits: Array<[string, (p: Project) => void, boolean]> = [
    ['editing a command\'s template (text)', p => { p.commands!.ship = '---\ndescription: ship it now\n---\nShip it all: $ARGUMENTS\n' }, false],
    ['adding a command', p => { p.commands!.fresh = '---\ndescription: new\n---\nhi\n' }, false],
    ['editing a skill body', p => { p.skills!.lint = '---\nname: lint\ndescription: how to lint well\n---\nrun the linter twice\n' }, false],
    ['editing an agent\'s prompt and description', p => { p.agents!.rev = '---\ndescription: a stricter reviewer\ntools: [file.read]\n---\nreview very carefully\n' }, false],
    ['adding a deny rule', p => { (p.settings!.rules as unknown[]).push({ id: 'd2', effect: 'deny', match: { pathGlob: 'prod/**' } }) }, false],
    ['editing a profile\'s DENY rule', p => { (p.profiles!.build as { rules: Array<{ match: unknown }> }).rules[1]!.match = { commandPrefix: ['npm', 'publish'] } }, false],
    ['adding an MCP server', p => { (p.settings!.mcpServers as Record<string, unknown>).extra = { type: 'http', url: 'https://mcp.example.com' } }, true],
    ['changing an MCP server\'s command', p => { (p.settings!.mcpServers as Record<string, { command: string[] }>).db!.command = ['bunx', 'evil-mcp'] }, true],
    ['adding an allow rule', p => { (p.settings!.rules as unknown[]).push({ id: 'npm', effect: 'allow', match: { commandPrefix: ['npm', 'test'] } }) }, true],
    ['editing an allow rule', p => { (p.settings!.rules as Array<{ match: unknown }>)[1]!.match = { commandPrefix: ['make', 'deploy'] } }, true],
    ['changing an after-edit step', p => { (p.settings!.afterEdit as Array<{ run: string[] }>)[0]!.run = ['curl', 'x'] }, true],
    ['widening an agent\'s tools', p => { p.agents!.rev = '---\ndescription: reviewer\ntools: [file.read, shell.start]\n---\nreview carefully\n' }, true],
    ['giving a text-only agent a profile', p => { p.agents!.plain = '---\ndescription: text only\npermissionProfile: build\n---\njust words\n' }, true],
    ['adding a profile allow rule', p => { (p.profiles!.build as { rules: unknown[] }).rules.push({ id: 'b2', effect: 'allow', match: { commandPrefix: ['bun', 'test'] } }) }, true],
    ['setting the starting profile', p => { p.settings!.profile = 'accept-edits' }, true],
  ]
  for (const [what, edit, reasks] of edits) {
    test(`${what} ${reasks ? 'CHANGES' : 'does not change'} the hash (criterion 2)`, () => {
      const p = clone(base)
      edit(p)
      const before = grantsManifest(input(base)).hash
      const after = grantsManifest(input(p)).hash
      if (reasks) expect(after).not.toBe(before)
      else expect(after).toBe(before)
    })
  }

  test('a power entry that fails to parse is still hashed: fixing it later is a change', () => {
    const broken = clone(base)
    broken.agents!.wide = '---\ndescription: wide\ntools: not-a-list\n---\nx\n'
    const m = grantsManifest(input(broken))
    expect(Object.keys(m.parts)).toContain('agent:wide')
  })
})

describe('trust decisions', () => {
  test('no record = untrusted; a matching record = trusted', () => {
    const m = grantsManifest(input(base))
    expect(trustDecision(emptyGrantsFile(), KEY, m).state).toBe('untrusted')
    const { file } = grantTrust(emptyGrantsFile(), KEY, m, NOW)
    const d = trustDecision(file, KEY, m)
    expect(d.state).toBe('trusted')
    if (d.state === 'trusted') expect(d.record.trustedAt).toBe(NOW.toISOString())
    // trust is per workspace root: another folder stays untrusted
    expect(trustDecision(file, '/home/ana/other', m).state).toBe('untrusted')
  })

  test('a changed subset is `changed`, with a sentence naming exactly what moved', () => {
    const { file } = grantTrust(emptyGrantsFile(), KEY, grantsManifest(input(base)), NOW)
    const p = clone(base)
    ;(p.settings!.mcpServers as Record<string, unknown>).extra = { type: 'http', url: 'https://mcp.example.com' }
    ;(p.settings!.mcpServers as Record<string, { command: string[] }>).db!.command = ['bunx', 'evil-mcp']
    ;(p.settings!.rules as unknown[]).splice(1, 1) // drop the allow rule `make`
    const d = trustDecision(file, KEY, grantsManifest(input(p)))
    expect(d.state).toBe('changed')
    if (d.state !== 'changed') return
    expect(d.diff).toEqual({ added: ['mcpServer:extra'], changed: ['mcpServer:db'], removed: ['rule:make'], unknown: false })
    expect(d.en).toContain('added the MCP server "extra"')
    expect(d.en).toContain('changed the MCP server "db"')
    expect(d.en).toContain('removed the allow rule "make"')
    expect(d.en).toContain('untrusted again')
    expect(d.pt).toContain('adicionou o servidor MCP "extra"')
  })

  test('a text-only edit keeps a trusted project trusted', () => {
    const { file } = grantTrust(emptyGrantsFile(), KEY, grantsManifest(input(base)), NOW)
    const p = clone(base)
    p.commands!.ship = '---\ndescription: different\n---\nsomething else entirely\n'
    expect(trustDecision(file, KEY, grantsManifest(input(p))).state).toBe('trusted')
  })

  test('describePart names every kind of part', () => {
    expect(describePart('rule:make').en).toBe('the allow rule "make"')
    expect(describePart('rule:make#2').en).toBe('the allow rule "make"')
    expect(describePart('profile').en).toBe('the starting profile')
    expect(describePart('agent:rev').pt).toBe('as ferramentas ou o perfil do agente "rev"')
  })
})

describe('untrust clears EVERYTHING the trust earned (criterion 2)', () => {
  function trustedWithApprovals(): GrantsFile {
    const m = grantsManifest(input(base))
    const { file } = grantTrust(emptyGrantsFile(), KEY, m, NOW)
    // B6.3 remembers per-server approvals inside the project's record.
    file.projects[KEY]!.servers = {
      db: { declaration: 'a'.repeat(64), approvedAt: NOW.toISOString() },
      docs: { declaration: 'b'.repeat(64), approvedAt: NOW.toISOString() },
    }
    file.user = { servers: { mine: { declaration: 'c'.repeat(64), approvedAt: NOW.toISOString() } } }
    return file
  }

  test('revoking removes the trust and names every server approval it dropped', () => {
    const { file, cleared } = revokeProject(trustedWithApprovals(), KEY)
    expect(cleared).toEqual({ trust: true, servers: ['db', 'docs'] })
    expect(file.projects[KEY]).toBeUndefined()
    // the person's OWN server approvals are not the project's to lose
    expect(file.user?.servers?.mine).toBeDefined()
  })

  test('untrust then trust: nothing the first trust earned survives', () => {
    const m = grantsManifest(input(base))
    const revoked = revokeProject(trustedWithApprovals(), KEY).file
    const again = grantTrust(revoked, KEY, m, new Date('2026-09-30T00:00:00.000Z')).file
    expect(again.projects[KEY]!.servers).toBeUndefined()
    expect(again.projects[KEY]!.trust!.trustedAt).toBe('2026-09-30T00:00:00.000Z')
  })

  test('trusting a CHANGED project replaces the record: old approvals do not carry over', () => {
    const file = trustedWithApprovals()
    const p = clone(base)
    ;(p.settings!.mcpServers as Record<string, unknown>).extra = { type: 'http', url: 'https://mcp.example.com' }
    const r = grantTrust(file, KEY, grantsManifest(input(p)), NOW)
    expect(r.already).toBe(false)
    expect(r.cleared).toEqual({ trust: true, servers: ['db', 'docs'] })
    expect(r.file.projects[KEY]!.servers).toBeUndefined()
  })

  test('trusting an already-trusted, unchanged project changes nothing', () => {
    const file = trustedWithApprovals()
    const r = grantTrust(file, KEY, grantsManifest(input(base)), new Date('2027-01-01T00:00:00.000Z'))
    expect(r.already).toBe(true)
    expect(r.file).toBe(file)
    expect(r.file.projects[KEY]!.servers?.db).toBeDefined()
  })

  test('revoking a project that was never trusted clears nothing and says so', () => {
    expect(revokeProject(emptyGrantsFile(), KEY).cleared).toEqual({ trust: false, servers: [] })
  })
})

describe('the file: a corrupt one reads as NOTHING trusted', () => {
  test('round trip', () => {
    const { file } = grantTrust(emptyGrantsFile(), KEY, grantsManifest(input(base)), NOW)
    const parsed = parseGrantsFile(serializeGrantsFile(file))
    expect(parsed.corrupt).toBe(false)
    expect(parsed.file).toEqual(file)
  })

  test('no file yet is empty and healthy', () => {
    expect(parseGrantsFile(null)).toEqual({ file: emptyGrantsFile(), corrupt: false })
  })

  const good = serializeGrantsFile(grantTrust(emptyGrantsFile(), KEY, grantsManifest(input(base)), NOW).file)
  const variants: Array<[string, string]> = [
    ['not JSON', '{"version":1,"projects":{'],
    ['an array', '[]'],
    ['a wrong version', good.replace('"version": 1', '"version": 2')],
    ['an unknown top-level key', good.replace('"version": 1', '"version": 1, "trustEverything": true')],
    ['a hash that is not a sha256', good.replace(/"grants": "[0-9a-f]{64}"/, '"grants": "yes"')],
    ['an unparseable instant', good.replace(/"trustedAt": "[^"]+"/, '"trustedAt": "always"')],
    ['an unknown key on a record', good.replace('"trust": {', '"trusted": true, "trust": {')],
    ['a server approval of the wrong shape', good.replace('"trust": {', '"servers": {"db": true}, "trust": {')],
  ]
  for (const [what, text] of variants) {
    test(`${what} → corrupt, nothing trusted`, () => {
      const parsed = parseGrantsFile(text)
      expect(parsed.corrupt).toBe(true)
      expect(parsed.file.projects).toEqual({})
      expect(trustDecision(parsed.file, KEY, grantsManifest(input(base))).state).toBe('untrusted')
    })
  }
})
