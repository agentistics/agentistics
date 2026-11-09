import { describe, expect, test } from 'bun:test'
import { applyGlass } from './glass'

describe('glass', () => {
  test('is always on, whatever a device stored before', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement
    applyGlass(root)
    expect(root.dataset.glass).toBe('on')
  })
})
