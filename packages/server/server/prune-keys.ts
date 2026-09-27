/**
 * prune-keys.ts — drop every key of a map that was not seen this tick.
 *
 * For state carried between polls and keyed on something that DIES — a pid — where a key that is
 * never seen again would otherwise be held for the life of the process. Mutates in place.
 */
export function retainKeys<K, V>(map: Map<K, V>, seen: ReadonlySet<K>): void {
  for (const key of map.keys()) if (!seen.has(key)) map.delete(key)
}
