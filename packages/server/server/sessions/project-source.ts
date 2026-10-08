/**
 * project-source.ts — where the wizard's candidates come from.
 *
 * THREE sources, merged, in descending order of how much we know about them:
 *
 *  1. **History** — the local consolidate store. Places you have actually worked, so they can be
 *     ranked by recency and carry their repository.
 *  2. **The home directory, walked** — because any folder should be startable. Limiting the wizard
 *     to places with history made it useless for the most ordinary case there is: a repository
 *     cloned five minutes ago.
 *  3. **A path typed in full** — the escape hatch for anywhere else on the machine, including
 *     outside `$HOME`.
 *
 * All three are read from disk directly rather than through the API, for the same reason
 * `conversations.ts` is: the control center must work with the server stopped, which is exactly the
 * state a user is in when they open it to start something.
 */

import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { countPerKind, pathForHost, PROJECTS_PER_KIND, projectKind, projectPathKey, takePerKind, type ProjectKind } from '@agentistics/core'
import { loadConsolidated } from '../consolidate'
import { isDirectory, isWholeDiskRoot, isWorktreeDir, scanDirectories, type ScanOptions } from './dir-scan'
import { DiskIndex, type DiskIndexProgress } from './disk-index'
import { discoverProjectDisks, type ProjectDisk } from '../disk-picker'
import { readPreferences } from '../preferences'
import {
  buildCandidates, mergeWalkedAndHistory, searchCandidates, withFixedCandidates,
  type ProjectCandidate,
} from './project-search'

/** Long enough that reopening the wizard is instant, short enough that a repo cloned a minute ago
 *  shows up without restarting the control center. */
const CACHE_TTL_MS = 60_000

interface ProjectCache { at: number; candidates: ProjectCandidate[]; indexing: boolean; indexProgress: DiskIndexProgress[] }
let cache: ProjectCache | null = null
let indexingPromise: Promise<void> | null = null
const diskIndex = new DiskIndex()

function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The home itself and temporary trees are implementation space, never places to start a session. */
export function isExcludedProjectPath(path: string, home = homedir(), temporary = tmpdir()): boolean {
  const candidate = normalPath(path)
  const homeRoot = normalPath(home)
  const temporaryRoot = normalPath(temporary)
  return candidate === homeRoot || candidate === temporaryRoot || candidate.startsWith(`${temporaryRoot}/`)
}

function visibleCandidates(candidates: readonly ProjectCandidate[]): ProjectCandidate[] {
  return candidates.filter(c => !isExcludedProjectPath(c.path))
}

async function readHistoryAndRoots(): Promise<{ history: ProjectCandidate[]; roots: string[] }> {
  const [history, roots] = await Promise.all([
    loadConsolidated().then(m => buildCandidates([...m.values()])).catch(() => [] as ProjectCandidate[]),
    readPreferences().then(p => p.scanRoots ?? []).catch(() => [] as string[]),
  ])
  const scanRoots = [...new Map(
    [homedir(), ...roots.map(root => pathForHost(root, process.platform === 'win32' ? 'win32' : 'linux'))]
      .filter(Boolean).map(root => [projectPathKey(root), root] as const),
  ).values()]
  return { history, roots: scanRoots }
}

function startBackgroundIndex(history: ProjectCandidate[], scanRoots: string[]): void {
  if (indexingPromise) return
  indexingPromise = (async () => {
    const diskRoots = scanRoots.filter(isWholeDiskRoot)
    diskIndex.configure(diskRoots)
    const regularRoots = scanRoots.filter(root => !isWholeDiskRoot(root))
    let regularWalked: ProjectCandidate[] = []
    const update = (snapshot: ReturnType<typeof diskIndex.snapshot>) => {
      const walked = [...regularWalked, ...snapshot.candidates].map(d => 'source' in d ? d : {
        path: d.path, name: d.name, remote: '', lastSeenMs: 0, sessions: 0,
        source: d.repo || d.worktree ? 'repo' : 'folder', worktree: d.worktree,
      }) as ProjectCandidate[]
      cache = { at: Date.now(), candidates: mergeWalkedAndHistory(visibleCandidates(walked), visibleCandidates(history)), indexing: snapshot.indexing || !!indexingPromise, indexProgress: snapshot.progress }
    }
    diskIndex.onSnapshot = update
    diskIndex.start()
    const scannedGroups = await Promise.all(regularRoots.map(root => {
      const options: ScanOptions = { timeBudgetMs: 1_000 }
      return scanDirectories(root, options).catch(() => [])
    }))
    regularWalked = scannedGroups.flat().map(d => ({
      path: d.path, name: d.name, remote: '', lastSeenMs: 0, sessions: 0,
      source: d.repo || d.worktree ? 'repo' : 'folder', worktree: d.worktree,
    }))
    const diskWalked: ProjectCandidate[] = diskIndex.snapshot().candidates.map(d => ({
      path: d.path, name: d.name, remote: '', lastSeenMs: 0, sessions: 0,
      source: d.repo || d.worktree ? 'repo' : 'folder', worktree: d.worktree,
    }))
    let candidates = mergeWalkedAndHistory(visibleCandidates([...regularWalked, ...diskWalked]), visibleCandidates(history))
    const unresolved = candidates.filter(c => c.worktree === undefined)
    if (unresolved.length > 0) {
      const flags = await Promise.all(unresolved.map(c => isWorktreeDir(c.path)))
      const resolved = new Map(unresolved.map((c, i) => [c.path, flags[i]!]))
      candidates = candidates.map(c => resolved.has(c.path) ? { ...c, worktree: resolved.get(c.path) } : c)
    }
    const snapshot = diskIndex.snapshot()
    cache = { at: Date.now(), candidates, indexing: snapshot.indexing, indexProgress: snapshot.progress }
  })().catch(() => {
    if (cache) cache = { ...cache, at: Date.now(), indexing: false }
  }).finally(() => { indexingPromise = null })
}

async function allCandidates(): Promise<ProjectCache> {
  const now = Date.now()
  if (cache) {
    if (now - cache.at >= CACHE_TTL_MS && !indexingPromise) {
      const { history, roots } = await readHistoryAndRoots()
      cache = { ...cache, indexing: true }
      startBackgroundIndex(history, roots)
    }
    return cache
  }
  const { history, roots } = await readHistoryAndRoots()
  cache = { at: now, candidates: visibleCandidates(history), indexing: true, indexProgress: [] }
  startBackgroundIndex(history, roots)
  return cache
}

/** Drop the index, so a directory created seconds ago is findable without waiting out the TTL. */
export function forgetProjects(): void {
  cache = null
}

/**
 * The places worth offering for `query`, best first.
 *
 * `cwd` is always a candidate, with or without history — starting where you already are is the
 * single most common thing anyone wants, and routing that through a search would bury it.
 */
export interface ProjectSearch {
  /** The rows to offer, ranked then capped per kind. */
  rows: ProjectCandidate[]
  /**
   * How many MATCHED, per kind — before the cap.
   *
   * The tabs carry these. Counting the returned rows instead made every tab read `12`, which is the
   * cap: a number that can never be anything else, stated as though it were a fact about the
   * machine. `rows` is what fits on screen; this is what is there.
   */
  totals: Record<ProjectKind, number>
  /** True while the local filesystem index is being refreshed in the background. */
  indexing: boolean
  indexProgress: DiskIndexProgress[]
  disks: { id: string; label: string; letter?: string; install: boolean; count: number }[]
}

function pathOnDisk(path: string, disk: ProjectDisk): boolean {
  const a = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const b = disk.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return a === b || a.startsWith(`${b}/`)
}

function diskForPath(path: string, disks: ProjectDisk[]): ProjectDisk | undefined {
  return disks.filter(d => pathOnDisk(path, d)).sort((a, b) => b.path.length - a.path.length)[0]
}

export function filterCandidatesByDisk<T extends { path: string }>(
  candidates: readonly T[], disks: readonly ProjectDisk[], requestedDisk?: string,
): { candidates: T[]; selectedDisk?: ProjectDisk } {
  const install = disks.find(d => d.isInstallDisk) ?? disks[0]
  const selectedDisk = requestedDisk === 'all' ? undefined : disks.find(d => d.path === requestedDisk) ?? install
  return {
    candidates: selectedDisk
      ? candidates.filter(c => diskForPath(c.path, [...disks])?.path === selectedDisk.path)
      : [...candidates],
    selectedDisk,
  }
}

export async function findProjects(
  query: string, cwd: string, perKind = PROJECTS_PER_KIND, requestedDisk?: string,
): Promise<ProjectSearch> {
  const indexed = await allCandidates()
  const configuredRoots = (await readPreferences().catch(() => ({ scanRoots: [] as string[] }))).scanRoots ?? []
  const discovered = await discoverProjectDisks().catch(() => [])
  const disks = discovered.filter(d => d.isInstallDisk || configuredRoots.some(root => pathOnDisk(root, d)))
  const filtered = filterCandidatesByDisk(visibleCandidates(indexed.candidates), disks, requestedDisk)
  const selectedDisk = filtered.selectedDisk
  const known = filtered.candidates

  // Only worth a `stat` when the path is not already KNOWN — `withFixedCandidates` keeps the known
  // entry's already-resolved `worktree` and merely overrides `source`, so paying for this twice
  // would be wasted the moment the cache is warm (the ordinary case: `cwd` is almost always
  // somewhere the walk or history has already seen).
  const cwdKnownWorktree = known.find(c => projectPathKey(c.path) === projectPathKey(cwd))?.worktree
  const fixed: ProjectCandidate[] = [{
    path: cwd,
    name: baseName(cwd),
    remote: '',
    lastSeenMs: 0,
    sessions: 0,
    source: 'cwd',
    worktree: cwdKnownWorktree ?? await isWorktreeDir(cwd),
  }]

  // A typed path that exists but is nowhere in the index — outside `$HOME`, or deeper than the walk
  // goes. Checked only when it LOOKS like a path, so an ordinary word never costs a stat.
  const typed = query.trim()
  if (typed.startsWith('/') || typed.startsWith('~')) {
    const path = typed.startsWith('~') ? typed.replace(/^~/, homedir()) : typed
    if (!known.some(c => projectPathKey(c.path) === projectPathKey(path)) && await isDirectory(path)) {
      fixed.push({
        path, name: baseName(path), remote: '', lastSeenMs: 0, sessions: 0, source: 'typed',
        worktree: await isWorktreeDir(path),
      })
    }
  }

  /**
   * RANKED IN FULL, then capped PER KIND — never a global cap after ranking.
   *
   * Measured on a real machine: `portif` ranked twenty rows of which fifteen were plain folders
   * with no git and no history, and the three repositories the person was looking for were what
   * the cap was spending its budget on. A directory named like the one you want must not be able
   * to push the one you want off the list. See `takePerKind`.
   */
  const visibleFixed = fixed.filter(c => !isExcludedProjectPath(c.path) && (!selectedDisk || diskForPath(c.path, disks)?.path === selectedDisk.path))
  const ranked = searchCandidates(withFixedCandidates(known, visibleFixed), query, Number.MAX_SAFE_INTEGER)
  const diskCounts = disks.map(d => ({
    id: d.path, label: d.label, ...(d.letter ? { letter: d.letter } : {}), install: d.isInstallDisk,
    count: searchCandidates(withFixedCandidates(indexed.candidates.filter(c => diskForPath(c.path, disks)?.path === d.path), []), query, Number.MAX_SAFE_INTEGER).length,
  }))
  return {
    rows: takePerKind(ranked, c => projectKind(c), perKind),
    totals: countPerKind(ranked, c => projectKind(c)),
    indexing: indexed.indexing,
    indexProgress: indexed.indexProgress,
    disks: diskCounts,
  }
}

export function diskIndexProgress(): DiskIndexProgress[] {
  return diskIndex.snapshot().progress
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}
