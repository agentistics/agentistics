import { describe, expect, test } from 'bun:test'
import {
  COMPAT_SKILL_FOREIGN_KEYS,
  parseAgentFile,
  parseCommandFile,
  parsePermissionProfileFile,
  parseSettingsFile,
  parseSkillFile,
  validateName,
} from './parse.ts'

const lineOf = (e: { problems: Array<{ line: number; code: string }> }, code: string): number | undefined => e.problems.find(p => p.code === code)?.line
const cmd = (fm: string, body = 'do it', scope: 'user' | 'project' | 'compat' = 'user') =>
  parseCommandFile({ text: `---\n${fm}\n---\n${body}`, path: 'c.md', name: 'c', scope })

describe('names', () => {
  test('regex boundaries', () => {
    expect(validateName('a'.repeat(64), 'p', 1)).toEqual([])
    expect(validateName('a'.repeat(65), 'p', 1)).toHaveLength(1)
    expect(validateName('Abc', 'p', 1)).toHaveLength(1)
    expect(validateName('-abc', 'p', 1)).toHaveLength(1)
    expect(validateName('a-b1', 'p', 1)).toEqual([])
  })
})

describe('commands', () => {
  test('happy path', () => {
    const e = cmd('description: Review\nargs: "<pr>"\nmodel: m\nagent: reviewer', 'Run !ls now')
    expect(e.enabled).toBe(true)
    expect(e.trust).toBe('n/a')
    expect(e.def).toEqual({ description: 'Review', args: '<pr>', model: 'm', agent: 'reviewer', template: 'Run !ls now' })
  })
  test('unknown key refused with its line, entry kept', () => {
    const e = cmd('description: x\ndescripton: y')
    expect(e.enabled).toBe(false)
    expect(lineOf(e, 'catalogue.unknown-key')).toBe(3)
    expect(e.problems[0]?.en).toContain('descripton')
    expect(e.def?.description).toBe('x')
  })
  test('override only in user scope', () => {
    expect(cmd('description: x\noverride: true').enabled).toBe(true)
    const p = cmd('description: x\noverride: true', 'b', 'project')
    expect(p.enabled).toBe(false)
    expect(lineOf(p, 'catalogue.override-scope')).toBe(3)
    expect(p.trust).toBe('untrusted')
    expect(cmd('description: x\noverride: true', 'b', 'compat').enabled).toBe(false)
  })
  test('empty template and missing description', () => {
    expect(lineOf(cmd('description: x', ''), 'catalogue.empty-body')).toBe(4)
    const e = cmd('args: y')
    expect(e.enabled).toBe(false)
    expect(e.def).toBeUndefined()
  })
  test('unclosed frontmatter still returns an entry', () => {
    const e = parseCommandFile({ text: '---\ndescription: x\n', path: 'c.md', name: 'c', scope: 'user' })
    expect(e.enabled).toBe(false)
    expect(e.problems.some(p => p.line === 1 && p.code === 'catalogue.frontmatter-syntax')).toBe(true)
  })
  test('bad name disables', () => {
    expect(parseCommandFile({ text: '---\ndescription: x\n---\nb', path: 'c.md', name: 'Bad', scope: 'user' }).enabled).toBe(false)
  })
})

describe('agents', () => {
  test('happy path and tools validation', () => {
    const e = parseAgentFile({ text: '---\ndescription: d\nmodel: m\ntools: [file.read, shell.start]\npermissionProfile: strict\n---\nBe careful', path: 'a.md', name: 'a', scope: 'user' })
    expect(e.enabled).toBe(true)
    expect(e.def).toEqual({ description: 'd', model: 'm', tools: ['file.read', 'shell.start'], permissionProfile: 'strict', prompt: 'Be careful' })
    const bad = parseAgentFile({ text: '---\ndescription: d\ntools: [a, ""]\n---\n', path: 'a.md', name: 'a', scope: 'user' })
    expect(bad.enabled).toBe(false)
    expect(lineOf(bad, 'catalogue.empty-item')).toBe(3)
  })
  test('empty prompt allowed', () => {
    expect(parseAgentFile({ text: '---\ndescription: d\n---\n', path: 'a.md', name: 'a', scope: 'user' }).enabled).toBe(true)
  })
})

describe('skills', () => {
  const sk = (fm: string, scope: 'user' | 'compat' = 'user', dirName = 'my-skill') =>
    parseSkillFile({ text: `---\n${fm}\n---\nbody`, path: 'SKILL.md', dirName, scope })
  test('happy path', () => {
    const e = sk('name: my-skill\ndescription: does x')
    expect(e.enabled).toBe(true)
    expect(e.name).toBe('my-skill')
    expect(e.def).toEqual({ description: 'does x', body: 'body' })
  })
  test('name must equal directory', () => {
    const e = sk('name: other\ndescription: d')
    expect(e.enabled).toBe(false)
    expect(lineOf(e, 'catalogue.skill-name-mismatch')).toBe(2)
    expect(e.name).toBe('my-skill')
  })
  test('foreign keys only in compat scope', () => {
    const fm = COMPAT_SKILL_FOREIGN_KEYS.map(k => `${k}: x`).join('\n')
    expect(sk(`name: my-skill\ndescription: d\n${fm}`, 'compat').enabled).toBe(true)
    const u = sk('name: my-skill\ndescription: d\nlicense: MIT')
    expect(u.enabled).toBe(false)
    expect(lineOf(u, 'catalogue.unknown-key')).toBe(4)
  })
  test('a totally unknown key is refused even in compat', () => {
    expect(sk('name: my-skill\ndescription: d\nbogus: 1', 'compat').enabled).toBe(false)
  })
})

describe('permission profiles', () => {
  const prof = (rules: string) => parsePermissionProfileFile({ text: `{\n "description": "p",\n "rules": ${rules}\n}`, path: 'p.json', name: 'p', scope: 'user' })
  test('happy path', () => {
    const e = prof('[{"id":"r1","effect":"deny","match":{"action":"write","pathGlob":".git/**"}},{"id":"r2","effect":"allow","match":{"commandPrefix":["git","status"]}}]')
    expect(e.enabled).toBe(true)
    expect(e.def?.rules.map(r => r.id)).toEqual(['r1', 'r2'])
  })
  test('allow write .git/** is refused naming git-internals; deny accepted', () => {
    const e = prof('[{"id":"y","effect":"allow","match":{"action":"write","pathGlob":".git/**"}}]')
    expect(e.enabled).toBe(false)
    expect(e.problems[0]?.en).toContain('git-internals')
    expect(e.problems[0]?.line).toBe(3)
    expect(e.def?.rules).toEqual([])
    expect(prof('[{"id":"n","effect":"deny","match":{"action":"write","pathGlob":".git/**"}}]').enabled).toBe(true)
  })
  test('rule validation: unknown key, bad action, empty match, duplicate id, bad prefix', () => {
    const e = prof('[\n{"id":"a","effect":"deny","match":{"tool":"x"},"extra":1},\n{"id":"b","effect":"deny","match":{"action":"fly"}},\n{"id":"c","effect":"deny","match":{}},\n{"id":"a","effect":"deny","match":{"tool":"y"}},\n{"id":"d","effect":"deny","match":{"commandPrefix":[]}}]')
    const codes = e.problems.map(p => p.code)
    expect(codes).toContain('catalogue.unknown-key')
    expect(codes).toContain('catalogue.rule-action')
    expect(codes).toContain('catalogue.rule-empty-match')
    expect(codes).toContain('catalogue.duplicate-rule-id')
    expect(e.problems.find(p => p.code === 'catalogue.unknown-key')?.line).toBe(4)
    expect(e.def?.rules.map(r => r.id)).toEqual([])
  })
  test('syntax error and duplicate JSON key keep the entry', () => {
    const e = parsePermissionProfileFile({ text: '{\n "rules": [\n', path: 'p.json', name: 'p', scope: 'user' })
    expect(e.enabled).toBe(false)
    expect(e.def).toBeUndefined()
    const d = parsePermissionProfileFile({ text: '{\n "rules": [],\n "rules": []\n}', path: 'p.json', name: 'p', scope: 'user' })
    expect(d.problems[0]).toMatchObject({ code: 'catalogue.syntax', line: 3 })
  })
  test('missing rules and unknown top-level key', () => {
    const e = parsePermissionProfileFile({ text: '{\n "rulez": []\n}', path: 'p.json', name: 'p', scope: 'user' })
    expect(e.problems.map(p => p.code).sort()).toEqual(['catalogue.missing-key', 'catalogue.unknown-key'])
  })
})

const SETTINGS = `{
  "defaultModel": {"provider":"anthropic","model":"claude-sonnet-5"},
  "rules": [{"id":"r","effect":"ask","match":{"action":"shell"}}],
  "profile": "default",
  "mcpServers": {
    "db": {"type":"stdio","command":["bunx","some-mcp"],"env":{"DB_URL":"{env:DB_URL}","API_TOKEN":"{env:API_TOKEN}"}},
    "docs": {"type":"http","url":"https://mcp.example.com","headers":{"Authorization":"Bearer {env:DOCS}"},"auth":{"credential":"my-docs-oauth-token"}}
  },
  "afterEdit": [
    {"match":"**/*.ts","run":["bunx","biome","format","--write","{path}"],"timeoutMs":20000},
    {"name":"lint","match":"**/*.md","run":["x"]}
  ],
  "compat": {"claudeSkills":false,"agentsSkills":true},
  "skills": {"budgetTokens":2000}
}`
const settings = (text: string, scope: 'user' | 'project' = 'user') => parseSettingsFile({ text, path: 's.json', scope })

describe('settings', () => {
  test('happy path in user scope', () => {
    const r = settings(SETTINGS)
    expect(r.problems).toEqual([])
    expect(r.settings.defaultModel).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(r.settings.rules?.map(x => x.id)).toEqual(['r'])
    expect(r.settings.profile).toBe('default')
    expect(r.settings.compat).toEqual({ claudeSkills: false, agentsSkills: true })
    expect(r.settings.skills).toEqual({ budgetTokens: 2000 })
    const names = r.entries.map(e => `${e.kind}:${e.name}:${e.enabled}`).sort()
    expect(names).toEqual(['afterEdit:lint:true', 'afterEdit:user-after-edit-1:true', 'mcpServer:db:true', 'mcpServer:docs:true'])
  })
  test('defaultModel and compat refused in project scope, rest still parsed', () => {
    const r = settings(SETTINGS, 'project')
    const codes = r.problems.map(p => p.code).sort()
    expect(codes).toEqual(['catalogue.compat-scope', 'catalogue.default-model-scope'])
    expect(r.problems.find(p => p.code === 'catalogue.default-model-scope')?.line).toBe(2)
    expect(r.problems.find(p => p.code === 'catalogue.default-model-scope')?.en).toContain('billing')
    expect(r.settings.defaultModel).toBeUndefined()
    expect(r.settings.compat).toBeUndefined()
    expect(r.settings.profile).toBe('default')
    expect(r.entries.find(e => e.kind === 'afterEdit' && e.name === 'project-after-edit-1')).toBeDefined()
    expect(r.entries.every(e => e.trust === 'untrusted')).toBe(true)
  })
  test('unknown keys at any level, with lines', () => {
    const r = settings('{\n "profil": "x",\n "skills": {\n  "budget": 1\n },\n "mcpServers": {"a": {"type":"stdio","command":["x"],\n "foo": 1}}\n}')
    const unknown = r.problems.filter(p => p.code === 'catalogue.unknown-key')
    expect(unknown.map(p => p.line).sort()).toEqual([2, 4])
    expect(r.entries[0]?.problems[0]).toMatchObject({ code: 'catalogue.unknown-key', line: 7 })
    expect(r.entries[0]?.enabled).toBe(false)
    expect(r.entries[0]?.def).toBeDefined()
  })
  test('syntax error -> empty settings, no entries, one problem', () => {
    const r = settings('{\n "a": }')
    expect(r.entries).toEqual([])
    expect(r.settings).toEqual({})
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]?.line).toBe(2)
  })
  test('duplicate key refused', () => {
    expect(settings('{\n "profile":"a",\n "profile":"b"\n}').problems[0]?.line).toBe(3)
  })
  test('bad mcp server name and type', () => {
    const r = settings('{"mcpServers":{"Bad":{"type":"stdio","command":["x"]},"ok":{"type":"ws"}}}')
    expect(r.entries.every(e => !e.enabled)).toBe(true)
    expect(r.entries.find(e => e.name === 'Bad')?.def).toBeDefined()
    expect(r.entries.find(e => e.name === 'ok')?.def).toBeUndefined()
  })
  test('rule floor hit in settings', () => {
    const r = settings('{"rules":[{"id":"x","effect":"allow","match":{"action":"write","pathGlob":".git/**"}}]}')
    expect(r.problems[0]?.code).toBe('catalogue.rule-floor')
    expect(r.settings.rules).toEqual([])
  })
})

describe('literal secrets are refused in both scopes, never echoed', () => {
  const TOKEN = 'Xk9fQ2mZ8vB3nL7pR4tY1wA6'
  const cases: Array<[string, string, string]> = [
    ['env value', `{"mcpServers":{"s":{"type":"stdio","command":["x"],"env":{"API_TOKEN":"${TOKEN}"}}}}`, TOKEN],
    ['header bearer', `{"mcpServers":{"s":{"type":"http","url":"https://a.b","headers":{"Authorization":"Bearer ${TOKEN}"}}}}`, TOKEN],
    ['url password', `{"mcpServers":{"s":{"type":"http","url":"https://user:hunter2pass@a.b"}}}`, 'hunter2pass'],
    ['argv token', `{"mcpServers":{"s":{"type":"stdio","command":["x","sk-ant-abcdefghijklmnop1234"]}}}`, 'sk-ant-abcdefghijklmnop1234'],
  ]
  for (const scope of ['user', 'project'] as const) {
    for (const [label, text, secret] of cases) {
      test(`${label} (${scope})`, () => {
        const r = settings(text, scope)
        const e = r.entries[0]
        expect(e?.enabled).toBe(false)
        const p = e?.problems.find(x => x.code === 'catalogue.literal-secret')
        expect(p).toBeDefined()
        expect(p?.en).not.toContain(secret)
        expect(p?.pt).not.toContain(secret)
        expect(p?.en).toContain('{env:VAR}')
        expect(e?.def).toBeDefined()
      })
    }
  }
  test('a secret outside mcpServers is a file-level problem', () => {
    const r = settings(`{\n "profile": "sk-ant-abcdefghijklmnop1234"\n}`)
    expect(r.problems.some(p => p.code === 'catalogue.literal-secret' && p.line === 2)).toBe(true)
    expect(r.problems.every(p => !p.en.includes('sk-ant-abcdefghijklmnop1234'))).toBe(true)
  })
  test('{env:VAR} references and credential ids are accepted', () => {
    const r = settings(SETTINGS)
    expect(r.entries.filter(e => e.kind === 'mcpServer').every(e => e.enabled)).toBe(true)
  })
})
