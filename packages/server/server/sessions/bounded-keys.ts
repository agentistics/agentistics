/**
 * bounded-keys.ts — a set of keys that cannot grow without bound (CROSSBIND MED-3).
 *
 * The refusal warnings are said once per pair, and the pairs are minted from session ids and source
 * paths: a long-running server that keeps meeting new collisions would otherwise hold every pair it
 * ever refused. The oldest key is evicted past `cap` (a re-added key moves to the newest end), and a
 * caller drops the keys of a session that left with `dropWhere`. Forgetting a key costs one repeated
 * log line, never a wrong answer.
 */
export class BoundedKeys {
  private readonly keys = new Map<string, true>()
  constructor(private readonly cap: number) {}

  has(key: string): boolean { return this.keys.has(key) }

  /** Add `key`; `false` when it was already there (the caller then stays quiet). */
  add(key: string): boolean {
    const had = this.keys.delete(key)
    this.keys.set(key, true)
    while (this.keys.size > this.cap) {
      const oldest = this.keys.keys().next().value
      if (oldest === undefined) break
      this.keys.delete(oldest)
    }
    return !had
  }

  dropWhere(pred: (key: string) => boolean): void {
    for (const k of [...this.keys.keys()]) if (pred(k)) this.keys.delete(k)
  }

  clear(): void { this.keys.clear() }
  get size(): number { return this.keys.size }
}
