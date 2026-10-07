/**
 * rebuild-flags.ts — PURE resolution of the one answer a rebuild needs, and nothing else.
 *
 * A rebuild reused Docker's layer cache, so `--rebuild` could produce an image byte-identical to the
 * one before it. A rebuild is a rebuild: `cache` defaults to `'fresh'` on the rebuild paths
 * (`rebuildFlags`), with `--cache` as the escape hatch — `--no-cache` means a full `bun install` +
 * Vite build inside the container every time, which is genuinely slow.
 *
 * Nothing in this file touches the filesystem, the network or `process` — it is argv in, argv out.
 */

/** Whether the image build may reuse Docker's layer cache. */
export type CacheChoice = 'reuse' | 'fresh'

/** What the user asked for. Optional: absent means "did not say". */
export interface RebuildFlags {
  cache?: CacheChoice
}

/** A pair of flags that contradict each other, in the spelling the user typed the canonical one. */
export type FlagConflict = readonly [string, string]

export type RebuildFlagsResult =
  | { ok: true; flags: RebuildFlags; rest: string[] }
  | { ok: false; conflict: FlagConflict }

const CACHE_FLAGS: Record<string, CacheChoice> = {
  '--cache': 'reuse',
  '--no-cache': 'fresh',
}

/**
 * Read the rebuild flags out of an argv, leaving everything else untouched in `rest`.
 *
 * Repeating the same answer is fine; asking for both is refused rather than resolved, because
 * either choice would be a guess at what the user meant.
 */
export function parseRebuildFlags(argv: readonly string[]): RebuildFlagsResult {
  const flags: RebuildFlags = {}
  const rest: string[] = []
  for (const arg of argv) {
    const cache = CACHE_FLAGS[arg]
    if (cache) {
      if (flags.cache && flags.cache !== cache) return { ok: false, conflict: ['--cache', '--no-cache'] }
      flags.cache = cache
      continue
    }
    rest.push(arg)
  }
  return { ok: true, flags, rest }
}

/** The same flags, read as a REBUILD: no cache unless the user explicitly asked to reuse it. */
export function rebuildFlags(flags: RebuildFlags): RebuildFlags & { cache: CacheChoice } {
  return { ...flags, cache: flags.cache ?? 'fresh' }
}

/**
 * The `docker compose` invocations that rebuild and recreate a compose service.
 *
 * `docker compose up` has no `--no-cache` — it is a `build` flag — so a cacheless rebuild is two
 * commands, and `--force-recreate` is what replaces `--build`'s recreate. Reusing the cache stays
 * the single `up -d --build` it always was.
 */
export function composeRebuildCommands(composeFile: string, flags: RebuildFlags): string[][] {
  const base = ['docker', 'compose', '-f', composeFile]
  if ((flags.cache ?? 'fresh') === 'reuse') return [[...base, 'up', '-d', '--build']]
  return [
    [...base, 'build', '--no-cache'],
    [...base, 'up', '-d', '--force-recreate'],
  ]
}
