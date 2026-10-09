import { describe, expect, test } from 'bun:test'
import { chooseFolderLabel } from './projectPickerCopy'

describe('project picker escape hatch', () => {
  test('uses the final list row wording in both languages', () => {
    expect(chooseFolderLabel(true)).toBe('Não achou? Escolher outra pasta…')
    expect(chooseFolderLabel(false)).toBe('Not here? Choose another folder…')
  })
})
