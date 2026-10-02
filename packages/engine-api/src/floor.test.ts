import { describe, expect, test } from 'bun:test'
import { floored, protectedGlobMatches, protectedGlobs, type ProtectedRule } from './floor'

const HOME = '/home/u'

/** A slice of the backup plan's real `secret` rows — both match kinds, and a data-dir row. */
const RULES: ProtectedRule[] = [
  { pattern: '.claude/.credentials.json', match: 'prefix' },
  { pattern: '.codex/auth.json', match: 'prefix' },
  { pattern: '.copilot/token', match: 'contains' },
  { pattern: '.agentistics/provider-keys', match: 'prefix' },
  { pattern: '.agentistics/preferences.json#team.token', match: 'prefix' },
  { pattern: '.key', match: 'contains' },
]

describe('protectedGlobs (1.3) — a `contains` row keeps its meaning', () => {
  const globs = protectedGlobs(RULES)

  test('a `.key` file anywhere under a harness home is floored — flat and nested', () => {
    expect(floored(globs, `${HOME}/.claude/x.key`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.claude/sessions/1.abc/creds.key.json`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.codex/x.key`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.claude/daemon/control.key`, HOME)).toBe(true)
  })

  test('the 1.2 reading (one $HOME-joined path) is exactly the gap: it floors ~/.key and nothing else', () => {
    const asPath = [`${HOME}/.key`]
    expect(floored(asPath, `${HOME}/.claude/x.key`, HOME)).toBe(false)
  })

  test('a workspace file that merely contains `.key` is NOT floored', () => {
    expect(floored(globs, `${HOME}/work/repo/src/hotkey.keymap.ts`, HOME)).toBe(false)
    expect(floored(globs, `${HOME}/work/repo/README.md`, HOME)).toBe(false)
  })

  test('prefix rows floor the file, its stem siblings and its subtree', () => {
    expect(floored(globs, `${HOME}/.claude/.credentials.json`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.claude/.credentials.json.bak`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.codex/auth.json/inner`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.claude/settings.json`, HOME)).toBe(false)
  })

  test('a `contains` row with a directory is floored wherever that directory sits', () => {
    expect(floored(globs, `${HOME}/.copilot/tokens/abc`, HOME)).toBe(true)
    expect(floored(globs, `${HOME}/.copilot/token`, HOME)).toBe(true)
  })

  test('.agentistics rows are left to the engine, which floors the whole data dir itself', () => {
    expect(globs.some(g => g.includes('.agentistics'))).toBe(false)
  })

  test('sorted, deduplicated, and only `*` / `**` — the dialect protectedGlobMatches reads', () => {
    expect(globs).toEqual([...new Set(globs)].sort())
    for (const g of globs) expect(/[?[\]]/.test(g)).toBe(false)
    expect(protectedGlobs([{ pattern: '.y/b', match: 'prefix' }, { pattern: '.y/b', match: 'prefix' }]))
      .toEqual(['~/.y/b', '~/.y/b*', '~/.y/b*/**'])
  })
})

describe('protectedGlobMatches', () => {
  test('`**` spans zero or more segments; `*` stays inside one', () => {
    expect(protectedGlobMatches('~/.a/**/*.k', `${HOME}/.a/x.k`, HOME)).toBe(true)
    expect(protectedGlobMatches('~/.a/**/*.k', `${HOME}/.a/b/c/x.k`, HOME)).toBe(true)
    expect(protectedGlobMatches('~/.a/*.k', `${HOME}/.a/b/x.k`, HOME)).toBe(false)
    expect(protectedGlobMatches('~/.a*/**', `${HOME}/.a`, HOME)).toBe(true)
  })

  test('a dot is literal', () => {
    expect(protectedGlobMatches('~/.key', `${HOME}/xkey`, HOME)).toBe(false)
  })
})
