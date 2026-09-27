/**
 * file-version-cache.ts — a parse cache keyed by FILE, holding one version of each, with a cap.
 *
 * The cache this replaces keyed on `path + mtime + size`, so a file still being written — a LIVE
 * subagent transcript — added an entry on every build it changed in, and the superseded entries
 * were never dropped: measured 80 -> 1024 entries (4k -> 177k parsed responses, ~85 MB) over 60
 * builds, growing for as long as the server ran. Keying by the file and storing the version beside
 * the value makes a new version REPLACE the old one, so the entry count is the number of distinct
 * files, never the number of versions seen.
 *
 * Distinct files are then bounded by `capacity`, least-recently-used first (a `Map` iterates in
 * insertion order, and a hit re-inserts). A finished file never changes version, so while the
 * machine's files fit under the cap it is parsed exactly once — the property the cache exists for.
 */
export class FileVersionCache<V> {
  private readonly entries = new Map<string, { version: string; value: V }>()

  constructor(readonly capacity: number) {
    // A cap of zero would cache nothing while looking like a cache; refuse it instead.
    if (!(capacity >= 1)) throw new Error(`FileVersionCache capacity must be >= 1, got ${capacity}`)
  }

  get size(): number {
    return this.entries.size
  }

  /** The value stored for exactly this version of the file, or `undefined`. A stale version misses. */
  get(file: string, version: string): V | undefined {
    const hit = this.entries.get(file)
    if (!hit || hit.version !== version) return undefined
    this.entries.delete(file)
    this.entries.set(file, hit)
    return hit.value
  }

  set(file: string, version: string, value: V): void {
    this.entries.delete(file)
    this.entries.set(file, { version, value })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }
}
