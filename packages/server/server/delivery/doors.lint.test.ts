/**
 * Computed destinations cannot evade this inventory: every raw writer outside the two stores is pinned, every reference
 * that can reach the books is pinned, and no production module may import a test-only one (S2a r2 F1, r3 N3).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rawWriters, storeReach, testOnlyImports } from './guard-ast.testing'
import { GUARDED_STORES, inventoryGrowth, liveInventory, moduleCeiling, r3Inventory, scannedSources, writerCeiling } from './guard-inventory.testing'
import { productionSources, read } from './lint-scan.testing'

const PKGS = join(import.meta.dir, '..', '..', '..')
export const offendingWriters = (src: string): string[] => rawWriters(src).map(c => c.id)

describe('raw writers and book references have a pinned, shrinking historical ceiling', () => {
  test('no new raw writer and no new book reference in any package, including computed targets / workers / JS / TSX', () => {
    const live = liveInventory(PKGS)
    expect(inventoryGrowth(live.writers, writerCeiling())).toEqual([])
    expect(inventoryGrowth(live.reach, r3Inventory().reach)).toEqual([])
    expect(inventoryGrowth(live.modules, moduleCeiling())).toEqual([])
  }, 60_000)
  test('no production module imports a test-only module (a *.testing / *.fixture / *.test import is scanned as production)', () => {
    const out: string[] = []
    for (const rel of scannedSources(PKGS)) for (const spec of testOnlyImports(read(PKGS, rel))) out.push(`${rel} → ${spec}`)
    expect(out).toEqual([])
  }, 60_000)
  test('the scanner detects the guarded stores themselves', () => {
    for (const rel of GUARDED_STORES) expect(offendingWriters(read(PKGS, rel)).length).toBeGreaterThan(0)
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

describe('r3 N3: the nine forms the r2 inventory did not see', () => {
  const forms: Record<string, string> = {
    'destructured rename from dynamic import': "const { writeFile: w } = await import('node:fs/promises'); await w(target, book)",
    'destructured rename from require': "const { writeFileSync: w } = require('node:fs'); w(target, book)",
    'Bun.file().write()': 'await Bun.file(target).write(book)',
    'globalThis.Bun.write': 'await globalThis.Bun.write(target, book)',
    'alias of Bun.write': 'const put = Bun.write; await put(target, book)',
    'element access': "import fs from 'node:fs'; fs['writeFileSync'](target, book)",
    'child_process cp': "import { execFileSync } from 'node:child_process'; execFileSync('cp', [from, target])",
    'Bun.spawn mv': "Bun.spawnSync(['mv', from, target])",
    'fs.link (hard link over the store)': "import { linkSync } from 'node:fs'; linkSync(from, target)",
  }
  for (const [name, src] of Object.entries(forms)) test(`${name} → a pinned site`, () => {
    expect(offendingWriters(src).length).toBeGreaterThanOrEqual(1)
    // …and therefore a NEW module carrying it grows the ceiling.
    expect(inventoryGrowth({ 'server/server/new-module.ts': offendingWriters(src) }, writerCeiling()).length).toBeGreaterThanOrEqual(1)
  })
  test('more of the same family: aliased Bun global, Bun.$, a Bun.file handle, a computed member of fs, symlink', () => {
    for (const src of [
      'const B = globalThis.Bun; await B.write(target, book)',
      "await Bun.$`cp ${from} ${target}`",
      'const f = Bun.file(target); await f.write(book)',
      "import * as fs from 'node:fs'; fs[method](target, book)",
      "import { symlink } from 'node:fs/promises'; await symlink(from, target)",
      "const cp = require('node:child_process'); cp.spawnSync('install', [from, target])",
    ]) expect(offendingWriters(src).length, src).toBeGreaterThanOrEqual(1)
    expect(offendingWriters('const write = (x: string) => x; write("a"); process.stdout.write("b"); await Bun.file(p).text()')).toHaveLength(0)
  })
  test('a *.testing.ts module imported by production is caught however it is imported', () => {
    for (const src of [
      "import { put } from './helper.testing'",
      "export { put } from './helper.testing.ts'",
      "const { put } = await import('./helper.testing')",
      "const { put } = require('./store-v2210.fixture')",
    ]) expect(testOnlyImports(src), src).toHaveLength(1)
    const d = mkdtempSync(join(tmpdir(), 'qa-scan-'))
    try {
      writeFileSync(join(d, 'helper.testing.ts'), "import { writeFile } from 'node:fs/promises'; export const put = (p: string, b: string) => writeFile(p, b)")
      writeFileSync(join(d, 'prod.ts'), "import { put } from './helper.testing'; await put(target, book)")
      const scanned = productionSources(d, d)
      expect(scanned).toEqual(['prod.ts']) // the helper is not scanned as production…
      expect(scanned.flatMap(rel => testOnlyImports(read(d, rel)))).toEqual(['./helper.testing']) // …so importing it is refused
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('retargeting an inherited call at a book keeps its call id but GROWS the book references, which are pinned', () => {
    const a = "async function save(dir: string, x: string) { const tmp = join(dir, 'cache.json'); await writeFile(tmp, x) }"
    const b = "async function save(dir: string, x: string) { const tmp = join(dir, 'tasks.json'); await writeFile(tmp, x) }"
    expect(offendingWriters(a)).toEqual(offendingWriters(b))
    expect(storeReach(a)).toEqual([])
    expect(inventoryGrowth({ 'server/server/sessions/registry.ts': storeReach(b) }, r3Inventory().reach)).toEqual(['server/server/sessions/registry.ts:text:tasks.json'])
    // A new module handed a book path through the config constant or the data dir grows it too.
    for (const src of ['import { TASKS_FILE } from "../config"; await helper(TASKS_FILE)', "await helper(join(AGENTISTICS_DATA_DIR, name))", 'const p = process.env.AGENTISTICS_TASKS_FILE'])
      expect(inventoryGrowth({ 'server/server/new-module.ts': storeReach(src) }, r3Inventory().reach).length, src).toBeGreaterThanOrEqual(1)
  })
})
