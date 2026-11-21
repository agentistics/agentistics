/** A migration ceiling pinned independently from the live inventory. Entries may disappear, never be replaced or added. */
import { readFileSync } from 'node:fs'
import { join, dirname, normalize, isAbsolute, relative } from 'node:path'
import { digest, localImports, moduleCapabilities, rawWriters, storeReach } from './guard-ast.testing'
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
  if (digest(text) !== '769e512b1c77e39668e938dd7dbccee82948dbe187bd5513714ea1e0e2d590cf') throw new Error('Historical guard inventory changed: the S2a ceiling is pinned to 1b1c8a941; migrate sites by supplying contexts, never enlarge the fixture')
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
export const R3_INVENTORY_DIGEST = '4f6448c5b94a6010dcb4040797a3bdefdd5719232188aae4895fef9cbd3589b4'
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
export function liveInventory(pkgs: string): { writers: Record<string, string[]>; reach: Record<string, string[]>; modules: Record<string, string[]> } {
  const writers: Record<string, string[]> = {}
  const reach: Record<string, string[]> = {}
  const modules: Record<string, string[]> = {}
  for (const rel of scannedSources(pkgs)) {
    const src = read(pkgs, rel)
    const caps = moduleCapabilities(src); if (caps.length) modules[rel] = caps
    if (!GUARDED_STORES.has(rel)) { const w = rawWriters(src).map(c => c.id); if (w.length) writers[rel] = w }
    const r = storeReach(src); if (r.length) reach[rel] = r
  }
  return { writers, reach, modules }
}

/** Independently pinned r3 source ceiling. Capability-bearing modules may disappear, never grow. */
export function moduleCeiling(): Record<string, string[]> {
  const text = readFileSync(join(import.meta.dir, 'guard-modules.fixture.json'), 'utf8')
  if (digest(text) !== '1958264491ab79a479ce2f876b13a5b929a957573df9819377d4f3d1db6c1347') throw new Error('Historical module capability inventory changed: shrink only')
  return JSON.parse(text).modules
}

/** Old (r2) ∪ r3 writer ceilings, as one multiset per file. */
export function writerCeiling(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const src of [historicInventory().writers, r3Inventory().writers]) for (const [f, ids] of Object.entries(src)) out[f] = [...(out[f] ?? []), ...ids]
  return out
}

/** Every importer inherits a raw writer's capability, including generic helpers and re-export chains. */
export function helperInventory(sources: Readonly<Record<string, string>>, base = join(process.cwd(), 'packages')): Record<string, string[]> {
  const capable = new Set(Object.entries(sources).filter(([, src]) => rawWriters(src).length > 0 || moduleCapabilities(src).length > 0).map(([rel]) => rel))
  const edges = new Map(Object.entries(sources).map(([rel, src]) => [rel, localImports(src).flatMap(spec => {
    const workspace = /^@agentistics\/([^/]+)(?:\/(.*))?$/.exec(spec)
    const p = spec.startsWith('.') ? normalize(join(dirname(rel), spec)) : isAbsolute(spec) ? relative(base, spec) : workspace ? `${workspace[1]}/${workspace[2] ?? 'src/index'}` : spec
    const resolved = [p, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map(ext => p + ext), p + '/index.ts', p + '/index.js', p.replace(/\.js$/, '.ts')].find(p => sources[p] !== undefined)
    return resolved ? [resolved] : []
  })]))
  let changed = true
  while (changed) {
    changed = false
    for (const [rel, imports] of edges) if (!capable.has(rel) && imports.some(p => capable.has(p))) { capable.add(rel); changed = true }
  }
  return Object.fromEntries([...edges].filter(([, imports]) => imports.some(p => capable.has(p))).map(([rel]) => [rel, ['raw-writer-helper']]))
}

/** r5 pins existing helper reuse independently; new importers must never be added to this ceiling. */
export function helperCeiling(): Record<string, string[]> {
  const text = readFileSync(join(import.meta.dir, 'guard-helpers.fixture.json'), 'utf8')
  if (digest(text) !== '3b4913acf90338fb1903fb2ab77190f6d195e0be6081ccba7cb632e655ac447c') throw new Error('Historical raw-writer helper inventory changed: shrink only')
  return JSON.parse(text)
}
