import { homedir } from 'node:os'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type SpecificationSkillSource =
  | { harness: string; kind: 'claude-plugins-json'; path: string }
  | { harness: string; kind: 'skill-directories'; path: string }

/** Pure configuration: the locations known to carry specification/design skills. */
export const SPECIFICATION_SKILL_SOURCES: readonly SpecificationSkillSource[] = [
  { harness: 'claude', kind: 'claude-plugins-json', path: '.claude/plugins/installed_plugins.json' },
  { harness: 'codex', kind: 'skill-directories', path: '.codex/skills' },
  { harness: 'gemini', kind: 'skill-directories', path: '.gemini/skills' },
  { harness: 'copilot', kind: 'skill-directories', path: '.copilot/skills' },
  { harness: 'kimi', kind: 'skill-directories', path: '.kimi/skills' },
  { harness: 'opencode', kind: 'skill-directories', path: '.config/opencode/skills' },
  { harness: 'antigravity', kind: 'skill-directories', path: '.gemini/antigravity/skills' },
]

type Reader = {
  readFile(path: string): string | undefined
  list(path: string): string[]
  mtime(path: string): number
}

const diskReader: Reader = {
  readFile(path) { try { return readFileSync(path, 'utf8') } catch { return undefined } },
  list(path) { try { return readdirSync(path) } catch { return [] } },
  mtime(path) { try { return statSync(path).mtimeMs } catch { return -1 } },
}

function sourceFor(harness: string): SpecificationSkillSource | undefined {
  return SPECIFICATION_SKILL_SOURCES.find(s => s.harness === harness)
}

function namesFromDirectories(path: string, reader: Reader): string[] {
  return reader.list(path).filter(name => reader.mtime(join(path, name, 'SKILL.md')) >= 0).sort()
}

function namesFromClaudePlugins(path: string, reader: Reader): string[] {
  const raw = reader.readFile(path)
  if (!raw) return []
  try {
    const plugins = (JSON.parse(raw) as { plugins?: Record<string, unknown> }).plugins ?? {}
    return Object.keys(plugins)
      .filter(key => key.toLowerCase().includes('superpowers'))
      .map(() => 'superpowers')
      .filter((name, index, all) => all.indexOf(name) === index)
  } catch { return [] }
}

const cache = new Map<string, { stamp: number; names: readonly string[] }>()

/** Read installed specification skills without starting a process. Results are cached by mtime. */
export function specificationSkillsFor(harness: string, home = homedir(), reader: Reader = diskReader): readonly string[] {
  const source = sourceFor(harness)
  if (!source) return []
  const path = join(home, source.path)
  const stamp = reader.mtime(path)
  const key = `${harness}\0${path}`
  const old = cache.get(key)
  if (old?.stamp === stamp) return old.names
  const names = source.kind === 'claude-plugins-json' ? namesFromClaudePlugins(path, reader) : namesFromDirectories(path, reader)
  cache.set(key, { stamp, names })
  return names
}

export function clearSpecificationSkillCache(): void { cache.clear() }
