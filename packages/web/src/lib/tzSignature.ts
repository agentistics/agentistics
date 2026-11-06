/**
 * tzSignature.ts — a cheap fingerprint of the runtime's time zone, so a cache of LOCAL days can be
 * dropped when the zone changes under it (a test that sets `TZ`, a laptop that travelled). Three
 * offsets across the year and decades are enough to tell the zones a person actually moves between.
 */
export function tzSignature(): string {
  return `${new Date(0).getTimezoneOffset()}:${new Date(1_500_000_000_000).getTimezoneOffset()}:${new Date(1_784_000_000_000).getTimezoneOffset()}`
}

/** A Map that empties itself when the time zone changes, and when it reaches `max` entries. */
export function localDayCache<K, V>(max: number): { get(k: K): V | undefined; set(k: K, v: V): void } {
  const m = new Map<K, V>()
  let sig = tzSignature()
  const check = () => { const now = tzSignature(); if (now !== sig) { sig = now; m.clear() } }
  return {
    get(k) { check(); return m.get(k) },
    set(k, v) { if (m.size >= max) m.clear(); m.set(k, v) },
  }
}
