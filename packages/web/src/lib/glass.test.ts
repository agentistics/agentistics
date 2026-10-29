import { describe, expect, test } from 'bun:test'
import { applyGlass } from './glass'

describe('glass switch', () => {
  test('applyGlass writes the attribute the CSS keys on', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement
    applyGlass(true, root)
    expect(root.dataset.glass).toBe('on')
    applyGlass(false, root)
    expect(root.dataset.glass).toBe('off')
  })
})
