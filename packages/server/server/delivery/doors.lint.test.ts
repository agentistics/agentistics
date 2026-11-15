/** Computed destinations cannot evade this inventory: every raw writer outside the two stores is pinned. */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { rawWriters } from './guard-ast.testing'
import { historicInventory, inventoryGrowth } from './guard-inventory.testing'
import { productionSources, read } from './lint-scan.testing'

const PKGS = join(import.meta.dir, '..', '..', '..')
const STORES = new Set(['server/server/sessions/task-store.ts', 'server/server/delivery/store.ts'])
export const offendingWriters = (src: string): string[] => rawWriters(src).map(c => c.id)

describe('raw writers have a pinned, shrinking historical ceiling', () => {
  test('no new raw writer in any package, including computed targets / workers / JS / TSX', () => {
    const actual: Record<string, string[]> = {}
    const sources = [...productionSources(PKGS, PKGS), ...productionSources(join(PKGS, '..', 'scripts'), PKGS)]
    for (const rel of sources) if (!STORES.has(rel)) actual[rel] = offendingWriters(read(PKGS, rel))
    expect(inventoryGrowth(actual, historicInventory().writers)).toEqual([])
  }, 30_000)
  test('the scanner detects the guarded stores themselves', () => {
    for (const rel of STORES) expect(offendingWriters(read(PKGS, rel)).length).toBeGreaterThan(0)
  })
  test('F1 mutants: indirect targets, aliases, namespace calls and Bun.write are inventoried', () => {
    for (const src of [
      "const target = join(dir, 'tasks.json'); await writeFile(target, advancedBook)",
      "import { writeFile as save } from 'node:fs/promises'; const target = helper(); await save(target, advancedBook)",
      "import * as promises from 'node:fs/promises'; await promises.copyFile(from, helper())",
      "await Bun.write(target, advancedBook)",
      "const save = fs.writeFile; await save(computed(), advancedBook)",
    ]) expect(offendingWriters(src)).toHaveLength(1)
    expect(offendingWriters('// writeFile(TASKS_FILE, x)\nconst s = "rename(a, tasks.json)"')).toHaveLength(0)
  })
})
