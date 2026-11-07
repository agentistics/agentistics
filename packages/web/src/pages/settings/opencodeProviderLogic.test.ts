import { describe, expect, it } from 'bun:test'
import { maybeMisfiledGo, pickerOrder, type OcProvider } from './opencodeProviderLogic'

const P = (id: string, kind: OcProvider['kind']): OcProvider => ({ id, label: id, url: 'https://x', kind })

describe('pickerOrder', () => {
  it("OpenCode's own products first, then the rest; connected ones last", () => {
    const list = [P('anthropic', 'byo'), P('opencode', 'zen'), P('opencode-go', 'go'), P('openai', 'byo')]
    expect(pickerOrder(list, []).map(p => p.id)).toEqual(['opencode', 'opencode-go', 'anthropic', 'openai'])
    expect(pickerOrder(list, [{ id: 'opencode-go', label: '', type: 'api' }]).map(p => p.id).at(-1)).toBe('opencode-go')
  })
})

describe('maybeMisfiledGo', () => {
  it('is the Zen-only shape', () => {
    expect(maybeMisfiledGo([{ id: 'opencode', label: '', type: 'api' }])).toBe(true)
    expect(maybeMisfiledGo([{ id: 'opencode', label: '', type: 'api' }, { id: 'opencode-go', label: '', type: 'api' }])).toBe(false)
    expect(maybeMisfiledGo([])).toBe(false)
  })
})
