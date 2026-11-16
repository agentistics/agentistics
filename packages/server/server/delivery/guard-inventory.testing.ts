/** A migration ceiling pinned independently from the live inventory. Entries may disappear, never be replaced or added. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest, rawWriters, storeReach } from './guard-ast.testing'
import { productionSources, read } from './lint-scan.testing'

export interface Inventory { base: string; contexts: Record<string, string[]>; writers: Record<string, string[]> }
export function inventoryGrowth(actual: Readonly<Record<string, readonly string[]>>, baseline: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = []
  for (const [file, sites] of Object.entries(actual)) {
    const remaining = [...(baseline[file] ?? [])]
    for (const site of sites) {
      const i = remaining.indexOf(site)
      if (i < 0) out.push(`${file}:${site}`)
      else remaining.splice(i, 1)
    }
  }
  return out
}

export function historicInventory(): Inventory {
  const text = readFileSync(join(import.meta.dir, 'guard-inventory.fixture.json'), 'utf8')
  if (digest(text) !== '306d9ca58eb550d2b96b4539e6cc2f39bf72d8c95175af65ee9c149e19fa461c') throw new Error('Historical guard inventory changed: the S2a ceiling is pinned to 1b1c8a941; migrate sites by supplying contexts, never enlarge the fixture')
  return JSON.parse(text)
}

/**
 * S2a r3 (QA r2 N3). The r2 detector missed whole FORMS of writer (destructuring renames, `Bun.file().write`, the Bun global
 * reached another way, element access, child processes, links), and identified a site by its call text, so retargeting an
 * inherited call at a book kept its identity. The r3 ceiling, pinned at the r3 base with its own digest, adds:
 *   - `writers`: the sites of the NEW forms that already existed (the r2 fixture keeps the old ones), may only shrink;
 *   - `reach`: per module, every reference that can reach the books (file names, data dir, env overrides, path helpers),
 *     may only shrink — deny by default: a retargeted call, or a new module handed a book path, grows it and fails.
 */
export interface ReachInventory { base: string; writers: Record<string, string[]>; reach: Record<string, string[]> }
export const R3_INVENTORY_DIGEST = '39bc59a50c4ab5e58ef88e8a0c21407d231ef2c5c43b141fe61a12bbc837c731'
export function r3Inventory(): ReachInventory {
  const text = readFileSync(join(import.meta.dir, 'guard-inventory-r3.fixture.json'), 'utf8')
  if (digest(text) !== R3_INVENTORY_DIGEST) throw new Error('Historical guard inventory changed: the S2a r3 ceiling is pinned; a writer or a book reference may disappear, never be added')
  return JSON.parse(text)
}

/** Every production module of the repo (packages + scripts), as `doors.lint.test.ts` scans them. */
export function scannedSources(pkgs: string): string[] {
  return [...productionSources(pkgs, pkgs), ...productionSources(join(pkgs, '..', 'scripts'), pkgs)]
}
export const GUARDED_STORES = new Set(['server/server/sessions/task-store.ts', 'server/server/delivery/store.ts'])

/** The live inventory: raw writers outside the two stores, and book references everywhere. */
export function liveInventory(pkgs: string): { writers: Record<string, string[]>; reach: Record<string, string[]> } {
  const writers: Record<string, string[]> = {}
  const reach: Record<string, string[]> = {}
  for (const rel of scannedSources(pkgs)) {
    const src = read(pkgs, rel)
    if (!GUARDED_STORES.has(rel)) { const w = rawWriters(src).map(c => c.id); if (w.length) writers[rel] = w }
    const r = storeReach(src); if (r.length) reach[rel] = r
  }
  return { writers, reach }
}

/** Old (r2) ∪ r3 writer ceilings, as one multiset per file. */
export function writerCeiling(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const src of [historicInventory().writers, r3Inventory().writers]) for (const [f, ids] of Object.entries(src)) out[f] = [...(out[f] ?? []), ...ids]
  return out
}
