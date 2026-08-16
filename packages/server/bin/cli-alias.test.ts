/**
 * `agentop tui` is an alias, and this is what stops it becoming a fork again.
 *
 * The alias is one line in `cli.ts`'s dispatch — `tui` is RENAMED into `start` before anything reads
 * the command — so the two cannot drift: a flag added to `start` is a flag `tui` has. The tests
 * below read the module's SOURCE rather than running it, because `cli.ts` is a top-level script that
 * starts servers as a side effect of being imported.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf8')

describe('agentop tui', () => {
  test('is renamed into `start` before the dispatch reads it', () => {
    expect(SOURCE).toContain("process.argv[2] === 'tui' ? 'start' : process.argv[2]")
  })

  test('has no branch of its own — a branch is a copy that drifts', () => {
    expect(SOURCE).not.toContain("command === 'tui'")
  })

  test('does not reach for the deleted standalone app', () => {
    // `runTui` and `App.tsx` are gone: the metrics are the control center's `dashboard` tab, and a
    // second Ink shell around the same screens is a second set of keys for the same material.
    expect(SOURCE).not.toContain('runTui')
    expect(SOURCE).not.toMatch(/import\(['"]@agentistics\/tui['"]\)/)
  })

  test('the help still names it, so nobody has to discover the rename by trying it', () => {
    expect(SOURCE).toMatch(/tui\s+Alias for 'start'/)
  })
})
