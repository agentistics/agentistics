import { describe, expect, test } from 'bun:test'
import { parseLastChoice, rememberLastChoice, readLastChoice, usableLastChoice } from './lastSessionChoice'

const offered = [{ id: 'claude' }, { id: 'codex' }]

describe('lastSessionChoice', () => {
  test('first use: nothing stored reads as no choice', () => {
    expect(parseLastChoice(null)).toBeNull()
    expect(parseLastChoice({})).toBeNull()
    expect(parseLastChoice([1])).toBeNull()
  })

  test('create with X, reopen: step 1 comes back as X, and carries nothing from later steps', () => {
    rememberLastChoice({ harnessId: 'codex', nativeProvider: '', model: 'm1', effort: 'high', mode: 'plan' })
    const c = readLastChoice()
    expect(c).toEqual({ harnessId: 'codex', nativeProvider: '', model: 'm1', effort: 'high', mode: 'plan' })
    // No field for title, folder, task or prompt can exist in what is remembered.
    expect(Object.keys(c!).sort()).toEqual(['effort', 'harnessId', 'mode', 'model', 'nativeProvider'])
  })

  test('only the wizard writes it: no server, MCP or CLI module can touch the remembered choice', async () => {
    const { Glob } = await import('bun')
    const writers: string[] = []
    for (const root of ['../../../server', '../../../mcp', '../../../tui/src']) {
      for await (const f of new Glob('**/*.{ts,tsx}').scan({ cwd: new URL(root, import.meta.url).pathname })) {
        if (f.includes('node_modules') || f.endsWith('.test.ts')) continue
        const src = await Bun.file(new URL(`${root}/${f}`, import.meta.url).pathname).text()
        if (/rememberLastChoice|newSessionLast/.test(src) && !f.endsWith('user-ui-prefs.ts')) writers.push(f)
      }
    }
    expect(writers).toEqual([])
  })

  test('a remembered assistant that is no longer offered falls back to the default', () => {
    const stored = { harnessId: 'gemini', model: 'x', effort: '', mode: 'default' }
    expect(usableLastChoice(stored, offered)).toBeNull()
    expect(usableLastChoice({ ...stored, harnessId: 'claude' }, offered)?.harnessId).toBe('claude')
    expect(usableLastChoice({ harnessId: 'claude' }, null)).toBeNull()
  })

  test('an unknown mode reads as default; junk fields read as empty', () => {
    expect(parseLastChoice({ harnessId: 'claude', mode: 'bogus', model: 5 })).toEqual(
      { harnessId: 'claude', nativeProvider: '', model: '', effort: '', mode: 'default' })
  })
})
