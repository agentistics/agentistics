/**
 * S2a — the low-level-writer lint (spec §2.5 "Inventory test (a)"): `task-store.ts` and `delivery/store.ts` are the ONLY
 * production modules that write `tasks.json` / `deliveries.json`. A new writer that bypasses them also bypasses the guard,
 * so it fails the build. (The guard itself is the choke point; this lint is the supplement that keeps the choke point whole.)
 *
 * A "write" is a call of writeFile / appendFile / truncate / unlink / rm (first argument), rename (either argument) or
 * copyFile / cp (the DESTINATION, second argument) whose argument text names one of the two documents.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { callsOf, productionSources, read, splitArgs } from './lint-scan.testing'

const SERVER = join(import.meta.dir, '..')
const PKG = join(SERVER, '..')
const NAMES = /\bTASKS_FILE\b|\bDELIVERIES_FILE\b|tasks\.json|deliveries\.json|defaultDeliveriesPath|AGENTISTICS_TASKS_FILE|AGENTISTICS_DELIVERIES_FILE/
const ALLOWED = new Set(['server/sessions/task-store.ts', 'server/delivery/store.ts'])

/** A writer's destination argument(s), by function. */
const WRITERS: Array<{ name: RegExp; dest: (a: string[]) => string[] }> = [
  { name: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|truncate|truncateSync|unlink|unlinkSync|rm|rmSync)/, dest: a => a.slice(0, 1) },
  { name: /\b(?:rename|renameSync)/, dest: a => a.slice(0, 2) },
  { name: /\b(?:copyFile|copyFileSync|cp|cpSync)/, dest: a => a.slice(1, 2) },
]

export function offendingWriters(src: string): string[] {
  const out: string[] = []
  for (const w of WRITERS) for (const c of callsOf(src, w.name)) if (w.dest(splitArgs(c.args)).some(a => NAMES.test(a))) out.push(`line ${c.line}: ${c.args.replace(/\s+/g, ' ').slice(0, 80)}`)
  return out
}

describe('only the two stores write the board and the delivery book', () => {
  test('no other production module writes tasks.json / deliveries.json', () => {
    const offenders: string[] = []
    for (const rel of productionSources(PKG, PKG)) {
      if (ALLOWED.has(rel.replace(/^server\//, 'server/'))) continue
      const hits = offendingWriters(read(PKG, rel))
      if (hits.length) offenders.push(`${rel} — ${hits.join('; ')}`)
    }
    expect(offenders).toEqual([])
  })

  test('the scanner sees what it claims to (it finds the stores\' own write calls, which name their file through a variable)', () => {
    expect(callsOf(read(PKG, 'server/delivery/store.ts'), /\brename/).length).toBeGreaterThan(0)
    expect(callsOf(read(PKG, 'server/sessions/task-store.ts'), /\brename/).length).toBeGreaterThan(0)
  })

  test('a mutant writer is caught: a module renaming a temp file onto TASKS_FILE', () => {
    expect(offendingWriters(`import { rename } from 'node:fs/promises'\nawait rename(tmp, TASKS_FILE)`).length).toBe(1)
    expect(offendingWriters(`await writeFile(join(dir, 'deliveries.json'), text)`).length).toBe(1)
    expect(offendingWriters(`await copyFile(TASKS_FILE, backup)`).length).toBe(0) // a READ of the document is not a write
    expect(offendingWriters(`// writeFile(TASKS_FILE, x)\nconst s = "rename(a, tasks.json)"`).length).toBe(0)
  })
})
