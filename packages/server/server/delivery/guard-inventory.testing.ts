/** A migration ceiling pinned independently from the live inventory. Entries may disappear, never be replaced or added. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from './guard-ast.testing'

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
