import { test, expect } from 'bun:test'
import { watchedEvent } from './watch-filter'

const NOISE = /(^|[/\\])(\.git|node_modules|plugins|cache|\.tmp|shell_snapshots|skills|memories|log|logs|bin|antigravity|history|ide|pkg)([/\\]|$)/

test('a transcript write is a change; noise trees and sqlite files are not', () => {
  expect(watchedEvent('-home-u-proj/3f5f.jsonl', NOISE)).toBe(true)
  expect(watchedEvent('-home-u-proj/3f5f/subagents/agent-a.jsonl', NOISE)).toBe(true)
  expect(watchedEvent('-home-u-proj/node_modules/x/index.js', NOISE)).toBe(false)
  expect(watchedEvent('cache/blob', NOISE)).toBe(false)
  expect(watchedEvent('state.sqlite-wal', NOISE)).toBe(false)
  expect(watchedEvent('-home-u-proj\\memories\\a.md', NOISE)).toBe(false)
})

test('the depth cap matches chokidar depth 6, measured from the watched root', () => {
  expect(watchedEvent('1/2/3/4/5/6/file.jsonl', NOISE)).toBe(true)
  expect(watchedEvent('1/2/3/4/5/6/7/file.jsonl', NOISE)).toBe(false)
})

test('an event with no file name is a change, never nothing', () => {
  expect(watchedEvent(null, NOISE)).toBe(true)
  expect(watchedEvent('', NOISE)).toBe(true)
})
