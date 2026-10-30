import { expect, test } from 'bun:test'
import { prettyModelLabel } from './prettyModelLabel'

test('a model id reads as a person names it', () => {
  expect(prettyModelLabel('claude', 'opus')).toBe('Opus 5')
  expect(prettyModelLabel('claude', 'claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModelLabel('claude', 'claude-sonnet-5-5-20261001')).toBe('Sonnet 5.5')
  expect(prettyModelLabel('claude', 'opus', 'Opus (menu)')).toBe('Opus (menu)')
  expect(prettyModelLabel('codex', 'some-unknown-id')).toBe('some-unknown-id')
})
