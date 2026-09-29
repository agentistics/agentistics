/**
 * catalogue.test.ts — the pieces together, through the package's public index: text in, parsed
 * entries, precedence, and the listing a `/catalogue` surface would draw. Pins B8 criteria 3–5 at
 * the level a host sees them, not only per module.
 */
import { describe, expect, test } from 'bun:test'
import {
  parseCommandFile,
  parsePermissionProfileFile,
  parseSettingsFile,
  parseSkillFile,
  problemSentence,
  resolveCatalogue,
  type CatalogueEntry,
} from '../index.ts'

const builtinHelp: CatalogueEntry<'command'> = {
  kind: 'command', name: 'help', scope: 'builtin', source: {}, enabled: true, trust: 'n/a', problems: [],
  def: { description: 'Help', template: '' },
}

describe('text in, listing out', () => {
  test('criterion 4: an invalid entry survives resolution, disabled, with a file:line sentence', () => {
    const broken = parseSkillFile({ text: '---\nname: review\ndescripton: typo\n---\nbody\n', path: '/p/.agentistics/skills/review/SKILL.md', dirName: 'review', scope: 'project' })
    const good = parseSkillFile({ text: '---\nname: review\ndescription: Reviews code\n---\nbody\n', path: '/u/harness/skills/review/SKILL.md', dirName: 'review', scope: 'user' })
    const { entries } = resolveCatalogue([broken, good])
    const listed = entries.filter(e => e.kind === 'skill' && e.name === 'review')
    expect(listed.length).toBe(2)
    const disabled = listed.find(e => e.scope === 'project')
    expect(disabled?.enabled).toBe(false)
    const sentences = (disabled?.problems ?? []).map(p => problemSentence(p))
    expect(sentences.some(s => s.startsWith('/p/.agentistics/skills/review/SKILL.md:3: ') && s.includes('descripton'))).toBe(true)
    expect(problemSentence(disabled!.problems[0]!, 'pt')).toContain('SKILL.md:')
    // the valid, wider one is the active one
    expect(listed.find(e => e.enabled)?.scope).toBe('user')
  })

  test('a repository cannot redefine a built-in command, and the refusal is listed', () => {
    const repo = parseCommandFile({ text: '---\ndescription: mine\n---\nDo it\n', path: '/p/.agentistics/commands/help.md', name: 'help', scope: 'project' })
    const { entries } = resolveCatalogue([builtinHelp, repo])
    const active = entries.filter(e => e.name === 'help' && e.enabled)
    expect(active.map(e => e.scope)).toEqual(['builtin'])
    expect(entries.find(e => e.scope === 'project')?.problems.map(p => p.code)).toContain('catalogue.builtin-shadow-refused')
  })

  test('criterion 3: a bypass profile cannot be written — each floor rule refused in words', () => {
    const text = JSON.stringify({
      description: 'yolo',
      rules: [
        { id: 'git', effect: 'allow', match: { action: 'write', pathGlob: '.git/**' } },
        { id: 'ssh', effect: 'allow', match: { pathGlob: '~/.ssh/**' } },
        { id: 'fp', effect: 'allow', match: { commandPrefix: ['git', 'push', '--force'] } },
        { id: 'ok', effect: 'allow', match: { action: 'write', pathGlob: 'src/**' } },
      ],
    }, null, 2)
    const e = parsePermissionProfileFile({ text, path: '/u/harness/profiles/yolo.json', name: 'yolo', scope: 'user' })
    expect(e.enabled).toBe(false)
    const floor = e.problems.filter(p => p.code === 'catalogue.rule-floor')
    expect(floor.length).toBe(3)
    const joined = floor.map(p => p.en).join(' | ')
    for (const subject of ['git-internals', 'credential-store', 'git-force-push']) expect(joined).toContain(subject)
    expect(e.def?.rules.map(r => r.id)).toEqual(['ok'])
  })

  test('criterion 5: a literal secret is refused in BOTH scopes, and the sentence never echoes it', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'
    for (const scope of ['user', 'project'] as const) {
      const r = parseSettingsFile({
        text: JSON.stringify({ mcpServers: { db: { type: 'stdio', command: ['bunx', 'x'], env: { KEY: secret } } } }, null, 2),
        path: `/${scope}/settings.json`, scope,
      })
      const db = r.entries.find(e => e.name === 'db')
      expect(db?.enabled).toBe(false)
      const p = db?.problems.find(x => x.code === 'catalogue.literal-secret')
      expect(p).toBeDefined()
      expect(p!.en).not.toContain(secret)
      expect(p!.pt).not.toContain(secret)
    }
  })

  test('the plugin kind has no parser and is not a catalogue kind', async () => {
    const mod = await import('../index.ts')
    expect(mod.CATALOGUE_KINDS).not.toContain('plugin' as never)
    expect(mod.RESERVED_KINDS).toContain('plugin')
  })
})
