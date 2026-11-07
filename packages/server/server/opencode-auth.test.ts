import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authDirCandidates, catalogProviders, checkKey, fixMisfiledGoKey, isProviderId, listConnected, parseAuth,
  readAuth, removeKey, saveKey, withKey, withoutProvider,
} from './opencode-auth'

const FAKE = 'sk-test-0000000000000000' // an invented value: the real auth.json is never a fixture

function scratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-authtest-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('pure rules', () => {
  test('provider ids are tokens, never paths or prototype keys', () => {
    for (const ok of ['opencode-go', 'opencode', 'github-copilot', 'zai-coding-plan']) expect(isProviderId(ok)).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'A', '__proto__', 'constructor', 7, null]) expect(isProviderId(bad)).toBe(false)
  })

  test('a pasted key is trimmed and must be one token', () => {
    expect(checkKey(`  ${FAKE}\n`)).toEqual({ ok: true, key: FAKE })
    expect(checkKey('')).toEqual({ ok: false, reason: 'empty' })
    expect(checkKey('a b')).toEqual({ ok: false, reason: 'whitespace' })
    expect(checkKey('a\u0000b')).toEqual({ ok: false, reason: 'control' })
    expect(checkKey('x'.repeat(2000))).toEqual({ ok: false, reason: 'too_long' })
  })

  test('withKey keeps every other entry, OAuth records included', () => {
    const doc = { anthropic: { type: 'oauth', refresh: 'r' }, 'opencode-go': { type: 'api', key: 'old' } }
    const next = withKey(doc, 'opencode-go', FAKE)
    expect(next.anthropic).toEqual(doc.anthropic)
    expect(next['opencode-go']).toEqual({ type: 'api', key: FAKE })
    expect(withoutProvider(next, 'opencode-go')).toEqual({ anthropic: doc.anthropic })
  })

  test('listConnected names providers and types and never carries a value', () => {
    const list = listConnected({ 'opencode-go': { type: 'api', key: FAKE }, anthropic: { type: 'oauth', refresh: 'r' } })
    expect(list).toEqual([
      { id: 'opencode-go', label: 'OpenCode Go', type: 'api' },
      { id: 'anthropic', label: 'Anthropic', type: 'oauth' },
    ])
    expect(JSON.stringify(list)).not.toContain(FAKE)
  })

  test('parseAuth reads a garbled or missing file as empty', () => {
    expect(parseAuth(null)).toEqual({})
    expect(parseAuth('not json')).toEqual({})
    expect(parseAuth('[1]')).toEqual({})
  })

  test('catalogProviders lists key-based providers after the curated ones, named by the catalog', () => {
    const json = JSON.stringify({
      zenmux: { name: 'ZenMux', env: ['ZENMUX_API_KEY'], doc: 'https://docs.zenmux.ai' },
      anthropic: { name: 'Anthropic', env: ['ANTHROPIC_API_KEY'] },
      local: { name: 'Local' },
    })
    expect(catalogProviders(json).map(p => p.id)).toEqual(['zenmux'])
    expect(catalogProviders('nope')).toEqual([])
  })

  test('macOS falls back to Application Support only as a second candidate', () => {
    expect(authDirCandidates({}, '/Users/u', 'darwin')).toEqual(['/Users/u/.local/share/opencode', '/Users/u/Library/Application Support/opencode'])
    expect(authDirCandidates({}, '/home/u', 'linux')).toEqual(['/home/u/.local/share/opencode'])
  })
})

describe('writing auth.json', () => {
  test('saves under the chosen provider, 0600, with no temp file left behind', () => scratch(async dir => {
    const out = await saveKey('opencode-go', ` ${FAKE} `, { dir, probe: async () => null })
    expect(out).toEqual({ ok: true, savedAs: 'opencode-go' })
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['auth.json'])
    expect((await readAuth(dir))['opencode-go']).toEqual({ type: 'api', key: FAKE })
  }))

  test('a Zen paste that the Go endpoint accepts is filed under opencode-go', () => scratch(async dir => {
    const out = await saveKey('opencode', FAKE, { dir, probe: async () => true })
    expect(out).toEqual({ ok: true, savedAs: 'opencode-go', movedFrom: 'opencode' })
    expect(Object.keys(await readAuth(dir))).toEqual(['opencode-go'])
  }))

  test('when the probe cannot tell, the person\'s choice stands', () => scratch(async dir => {
    const out = await saveKey('opencode', FAKE, { dir, probe: async () => null })
    expect(out).toEqual({ ok: true, savedAs: 'opencode' })
  }))

  test('a refused key is not written at all', () => scratch(async dir => {
    expect(await saveKey('opencode-go', 'a b', { dir })).toEqual({ ok: false, reason: 'whitespace' })
    expect(await saveKey('../x', FAKE, { dir })).toEqual({ ok: false, reason: 'bad_provider' })
    expect(readdirSync(dir)).toEqual([])
  }))

  test('the other providers survive a save and a removal', () => scratch(async dir => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r' } }))
    await saveKey('opencode-go', FAKE, { dir, probe: async () => null })
    expect(Object.keys(await readAuth(dir)).sort()).toEqual(['anthropic', 'opencode-go'])
    expect(await removeKey('opencode-go', dir)).toBe(true)
    expect(await removeKey('opencode-go', dir)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual({ anthropic: { type: 'oauth', refresh: 'r' } })
  }))

  test('fixMisfiledGoKey moves a Go key out of `opencode`, and only when Go accepts it', () => scratch(async dir => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: FAKE } }))
    expect(await fixMisfiledGoKey({ dir, probe: async () => false })).toBe(false)
    expect(await fixMisfiledGoKey({ dir, probe: async () => null })).toBe(false)
    expect(Object.keys(await readAuth(dir))).toEqual(['opencode'])
    expect(await fixMisfiledGoKey({ dir, probe: async () => true })).toBe(true)
    expect(await readAuth(dir)).toEqual({ 'opencode-go': { type: 'api', key: FAKE } })
    expect(await fixMisfiledGoKey({ dir, probe: async () => true })).toBe(false)
  }))
})
