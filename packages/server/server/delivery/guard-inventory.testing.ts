/** A migration ceiling pinned independently from the live inventory. Entries may disappear, never be replaced or added. */
import { readFileSync } from 'node:fs'
import { join, dirname, normalize, isAbsolute, relative } from 'node:path'
import { digest, localImports, moduleCapabilities, rawWriters, storeReach } from './guard-ast.testing'
import { isBuildOutput, productionSources, read } from './lint-scan.testing'

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
  if (digest(text) !== 'f3ef9db48bbb7bfee031c0b706a0cb49a1b02f4c25f94e52d31d3b708b1f9e74') throw new Error('Historical guard inventory changed: the S2a ceiling is pinned to 1b1c8a941 and S2c emptied its context allowlist; supply contexts, never refill the fixture')
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
/**
 * DURABILITY admission (2026-11-22, #1495, leader decision recorded on t-79061d4f20): after the disk crash of 2026-11-21
 * zero-filled the board and the session registry, `server/durable-file.ts` (`durableWrite`: fsync file -> rename ->
 * fsync dir) became the ONE primitive for non-regenerable state; 13 modules dropped their own writeFile+rename for it,
 * so the repo-wide raw-writer count shrinks. Its own sites (and `sessions/native-notes.ts` as a new importer) are the
 * only entries added; the ceiling stays shrink-only from here.
 */
/**
 * DOCKER.AMBIENTES S2 admission (2026-11-27, t-e1dea7cd6f / s-072b26eace, leader decision recorded on the subtask):
 * the per-command Docker backend needs IO the shrink-only ceiling did not have. ONLY new sites of
 * `server/server/docker-env/` plus ONE site of `cli-run.ts` are added; no existing site changes class. Each, and why:
 *   cli-run.ts:939            spawn  re-enter `agentop heavy -- agentop run …` so the LAUNCHER holds the heavy lock
 *   docker-env/docker-cli.ts:26,35 spawnSync/spawn of the `docker` client — the ONE door, every argv through argvRefusal
 *   docker-env/docker-run.ts:72     spawnSync git  (worktree root, untracked/ignored list for the masks)
 *   docker-env/docker-run.ts:126    writeFileSync  agentop's own exec-wrap/fwd.mjs under <dataDir>/docker/opt (0555)
 *   docker-env/docker-run.ts:159    spawnSync tmux (list-panes: the session's root pid, identity by ancestry)
 *   docker-env/docker-run.ts:301,308 spawnSync du / df (the disk watchdog)
 *   docker-env/docker-run.ts:320,336 write/remove the helper containers' env-file (0600)
 *   docker-env/docker-run.ts:383,397 write/remove the command's --env-file (0600, removed right after create)
 *   docker-env/docker-run.ts:399,430 remove the exec's run dir
 *   docker-env/egress-proxy.ts:37,71 the egress journal (host/port/decision only) and the fresh unix socket
 *   docker-env/env-install.ts:83,95  remove the egress socket dir and the helper env-file
 *   docker-env/ledger.ts:53-55,66-68,73 the ledger's atomic write (0600 + fsync + rename) and its O_EXCL lock file
 *     (synchronous on purpose: decided inside the cross-process lock; `durableWrite` is async).
 * Round 2 (SPEC r4 fixes, same decision): new sites ONLY, nothing existing changes class —
 *   docker-env/env-install.ts  remove the per-install staging dir (twice: refusal and end) and the egress socket dir
 *   docker-env/ledger.ts       the lock is now published with link(2) from a private pid file (+ removal of that temp
 *     file and of a stale lock): same file, same single-writer purpose, no longer observable empty
 *   docker-env/staging.ts      the host-generated staging the download container mounts INSTEAD of the worktree
 *     (copies of package.json / lockfile / workspace file + one generated .npmrc, mode 0700/0600, under <dataDir>/docker/run)
 * Book-reach texts added (neither is agentop's data dir): docker-env/env-profile.ts `PROFILE_REL` = the REPO's
 *   `.agentistics/env.yml` (worktree-relative), and docker-env/plans.ts `VOLUME_MARKER` = `/v/.agentistics-volume`, a path
 *   INSIDE a container's view of a volume root.
 * Capability-bearing modules added (fs / child_process): docker-cli, docker-run, egress-proxy, env-install, ledger,
 * session-proof (reads /proc only); helper importers: docker-run, env-install. Fixtures, fakes and live proofs are
 * `*.testing.ts` and stay outside the inventory. The ceiling stays shrink-only from here.
 */
export const R3_INVENTORY_DIGEST = 'fc818e00d7e48230b6adcc8e84ae9967cb8b9b072f1c735d8ff0a8f954f8f2b9'
export function r3Inventory(): ReachInventory {
  const text = readFileSync(join(import.meta.dir, 'guard-inventory-r3.fixture.json'), 'utf8')
  if (digest(text) !== R3_INVENTORY_DIGEST) throw new Error('Historical guard inventory changed: the S2a r3 ceiling is pinned; a writer or a book reference may disappear, never be added')
  return JSON.parse(text)
}

/** Every production module of the repo (packages + scripts), as `doors.lint.test.ts` scans them. */
export function scannedSources(pkgs: string): string[] {
  return [...productionSources(pkgs, pkgs), ...productionSources(join(pkgs, '..', 'scripts'), pkgs)].filter(rel => !isBuildOutput(rel))
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
  if (digest(text) !== '23d89606f99dcfede59a9b649ae350f5174c6dd71a77edd814d6901cbe02fe87') throw new Error('Historical module capability inventory changed: shrink only')
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
  if (digest(text) !== '361e334b6e367744eade103a673ae12904c6080e6a44963a69b6e0648a26fe68') throw new Error('Historical raw-writer helper inventory changed: shrink only')
  return JSON.parse(text)
}
