import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, readSource, sha256 } from './sync.ts'

describe('the copies of the engine repo\'s bench files', () => {
  test('SOURCE.json describes every file of the bench set', () => {
    expect(Object.keys(readSource().files).sort()).toEqual(['bench.ts', 'fake-harness', 'tmux-shim'])
  })
  test('each copy is the one SOURCE.json recorded (and an identical one equals the engine\'s)', () => {
    const { findings } = check()
    expect(findings).toEqual([])
  })
  test('a patched file lists its differences in its own header', () => {
    const src = readFileSync(join(import.meta.dir, 'bench.ts'), 'utf8')
    expect(src).toContain('Differences from the engine')
    expect(readSource().files['bench.ts']!.mode).toBe('patched')
  })
  test('every harness the fleet is built from has a fake binary', () => {
    const run = readFileSync(join(import.meta.dir, 'run.sh'), 'utf8')
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'agy']) expect(run).toContain(h)
    expect(existsSync(join(import.meta.dir, 'fake-harness'))).toBe(true)
  })
  test('sha256 of an empty input is the well-known digest', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
