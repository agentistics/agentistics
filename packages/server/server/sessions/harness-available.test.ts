import { expect, test, describe } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_ORDER } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'
import { availableHarnesses, resetHarnessAvailability, startableHarnessIds } from './harness-available'

describe('availableHarnesses — what the session wizard may offer', () => {
  test('startable is spec-derived, never a second hand-written list', () => {
    expect(startableHarnessIds()).toEqual(HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null))
  })

  test('the offer is a subset of what agentop knows how to spawn', () => {
    const startable = new Set(startableHarnessIds())
    for (const id of availableHarnesses().ids) expect(startable.has(id)).toBe(true)
  })

  test('`ids` keeps the teach-everything fallback; `blind` says it happened', () => {
    // `ids` is what the generated skill teaches, and stays non-empty. `blind` is what the session
    // WIZARD reads: zero CLIs on PATH is a broken PATH, and offering all six there made every pick
    // a pane that died at once.
    expect(availableHarnesses().ids.length).toBeGreaterThan(0)
  })

  test('a PATH that reaches no harness is BLIND, not "every harness"', () => {
    const saved = process.env.PATH
    const savedHome = process.env.HOME
    const emptyHome = mkdtempSync(join(tmpdir(), 'agentop-home-'))
    try {
      // An empty HOME too: ~/.local/bin is searched on purpose, and a real one may hold a harness.
      process.env.HOME = emptyHome
      process.env.PATH = '/nonexistent-agentop-test-dir'
      resetHarnessAvailability()
      const out = availableHarnesses()
      expect(out.blind).toBe(true)
      expect(out.ids).toEqual(startableHarnessIds())
    } finally {
      process.env.PATH = saved
      process.env.HOME = savedHome
      resetHarnessAvailability()
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  test('a harness installed in ~/.local/bin is available even when the service PATH lacks it', () => {
    const savedPath = process.env.PATH
    const savedHome = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), 'agentop-home-'))
    try {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      // An installed antigravity and kimi must show too: only the Install affordance is limited
      // to the four harnesses with installers, never the list itself.
      for (const id of ['codex', 'antigravity', 'kimi'] as const) {
        const bin = join(home, '.local', 'bin', SPAWN_SPECS[id]!.bin)
        writeFileSync(bin, '#!/bin/sh\nexit 0\n'); chmodSync(bin, 0o755)
      }
      process.env.HOME = home
      process.env.PATH = '/nonexistent-agentop-test-dir'
      resetHarnessAvailability()
      const out = availableHarnesses()
      expect(out.blind).toBe(false)
      expect(out.ids).toContain('codex')
      expect(out.ids).toContain('antigravity')
      expect(out.ids).toContain('kimi')
      expect(out.ids).not.toContain('claude')
      // The pane is handed this process's PATH, so it must carry the same directory.
      expect(process.env.PATH!.split(':')[0]).toBe(join(home, '.local', 'bin'))
    } finally {
      process.env.PATH = savedPath
      process.env.HOME = savedHome
      resetHarnessAvailability()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
