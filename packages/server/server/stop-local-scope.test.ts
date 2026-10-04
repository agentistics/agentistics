/**
 * "Stop the local server" may signal ONLY the server of this data dir — never a pattern match over
 * the machine. See `planLocalStop` in cli-start.ts for the incident: on Linux the old fallback,
 * `pkill -f 'agentop server'`, ran on every stop and SIGTERMed every other HOME's preview server,
 * the shell wrappers around them and any tmux server whose stored command said those words.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { planLocalStop } from './cli-start'

describe('planLocalStop', () => {
  test('the lock holder alone is enough — the case lsof cannot see (Bun is non-dumpable)', () => {
    expect(planLocalStop({ listeners: [], lockHolder: 1770369, self: 42 })).toEqual([1770369])
  })
  test('listener and lock holder, deduplicated', () => {
    expect(planLocalStop({ listeners: ['1770369', '1770369'], lockHolder: 1770369, self: 42 })).toEqual([1770369])
  })
  test('never ourselves, never init, never junk', () => {
    expect(planLocalStop({ listeners: ['42', '1', '', 'abc', '0'], lockHolder: 42, self: 42 })).toEqual([])
  })
  test('nothing on record means NOTHING is signalled — no widening to a pattern', () => {
    expect(planLocalStop({ listeners: [], lockHolder: null, self: 42 })).toEqual([])
  })
})

describe('no stop path matches processes by pattern', () => {
  const SERVER = join(import.meta.dir)
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out) }
      else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p)
    }
    return out
  }
  test("no server source spawns pkill/killall, or `kill` with a pattern", () => {
    const offenders: string[] = []
    for (const f of [...walk(SERVER), join(SERVER, '..', 'bin', 'cli.ts')]) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (/\[\s*['"](pkill|killall)['"]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
