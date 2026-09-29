import { describe, expect, test } from 'bun:test'
import { typedModelId } from './chatModel'

describe('typedModelId', () => {
  test('trims, and refuses spaces and flag-shaped values', () => {
    expect(typedModelId('  gpt-4.1 ')).toBe('gpt-4.1')
    expect(typedModelId('--yolo')).toBeNull()
    expect(typedModelId('gpt 4')).toBeNull()
    expect(typedModelId('')).toBeNull()
  })
})
