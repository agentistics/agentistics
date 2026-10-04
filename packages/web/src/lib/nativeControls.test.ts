import { describe, expect, test } from 'bun:test'
import { NATIVE_EFFORTS, nativeControls, nativeProviderKey } from './nativeChatSource'

function verbs() {
  const calls: string[] = []
  return {
    calls,
    v: {
      switchModel: async (m: string) => { calls.push(`model:${m}`); return null },
      setEffort: async (e: string) => { calls.push(`effort:${e}`); return null },
      setBrowser: async (on: boolean) => { calls.push(`browser:${on}`); return null },
      addDir: async (p: string) => { calls.push(`dir:${p}`); return 'refused: /' },
    },
  }
}

describe('nativeControls — the native session\'s settings in the standard composer (UI.UNIFY regression)', () => {
  test('nothing before the first window read', () => {
    expect(nativeControls(null, false, [], verbs().v)).toBeUndefined()
  })
  test('model, effort, browser and folders from the window; the current model is always offered', () => {
    const c = nativeControls({ model: 'typed-id', effort: 'medium', browser: true, extraDirs: ['/x'] }, true, [{ id: 'a', label: 'A' }], verbs().v)!
    expect(c.busy).toBe(true)
    expect(c.model!.options.map(o => o.id)).toEqual(['typed-id', 'a'])
    expect(c.model!.freeText).toBe(true)
    expect(c.effort!.value).toBe('medium')
    expect(c.effort!.efforts).toEqual(NATIVE_EFFORTS)
    expect(c.browser!.on).toBe(true)
    expect(c.extraDirs!.dirs).toEqual(['/x'])
  })
  test('the verbs reach the engine calls; effort "" is off; picking the current model calls nothing', async () => {
    const { calls, v } = verbs()
    const c = nativeControls({ model: 'm1' }, false, [{ id: 'm1', label: 'm1' }, { id: 'm2', label: 'm2' }], v)!
    expect(c.effort!.value).toBe('')
    await c.model!.switch('m1')
    await c.model!.switch('m2')
    await c.effort!.set('')
    await c.effort!.set('high')
    await c.browser!.set(true)
    expect(await c.extraDirs!.add('/')).toBe('refused: /')
    expect(calls).toEqual(['model:m2', 'effort:off', 'effort:high', 'browser:true', 'dir:/'])
  })
  test('an OpenAI-compatible session lists its ENDPOINT\'s models', () => {
    expect(nativeProviderKey({ provider: 'openai-compatible', credential: { provider: 'openai-compatible', id: 'ollama' } })).toBe('ollama')
    expect(nativeProviderKey({ provider: 'anthropic', credential: { provider: 'anthropic', id: 'default' } })).toBe('anthropic')
    expect(nativeProviderKey(null)).toBe('')
  })
})
