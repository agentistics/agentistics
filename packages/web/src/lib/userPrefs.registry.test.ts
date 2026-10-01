import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
// A TEST may read the server's registry directly; the bundle never does.
import { isUserUiPrefKey } from '../../../server/server/user-ui-prefs'

/**
 * Every server-backed store must name a key `/api/user-prefs` will actually keep. The route's list
 * is CLOSED: a store registered under any other key has every PUT refused, reads nothing back, and
 * quietly resets to its fallback on every load — on every device, for everyone.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const WEB_SRC = join(import.meta.dir, '..')

test('every createSharedPref / createPersonalDoc / putPersonal key is in USER_UI_PREF_REGISTRY', () => {
  const found: string[] = []
  for (const file of sources(WEB_SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/prefKey:\s*'([^']+)'/g)) found.push(`${file}: ${m[1]}`)
    for (const m of text.matchAll(/createPersonalDoc\(\s*[^,]+,\s*'([^']+)'/g)) found.push(`${file}: ${m[1]}`)
    for (const m of text.matchAll(/putPersonal\(\{([^}]*)\}/g)) {
      for (const k of m[1]!.matchAll(/(?:^|[,{\s])([A-Za-z]+)\s*:/g)) found.push(`${file}: ${k[1]}`)
    }
  }
  expect(found.length).toBeGreaterThan(25)
  const unknown = found.filter(f => !isUserUiPrefKey(f.slice(f.lastIndexOf(': ') + 2)))
  expect(unknown).toEqual([])
})

test('no store points at the shared machine file', () => {
  const offenders = sources(WEB_SRC).filter(f => /endpoint:\s*'\/api\/preferences'/.test(readFileSync(f, 'utf8')))
  expect(offenders).toEqual([])
})

test('no web code PUTs a personal choice to /api/preferences any more', () => {
  const offenders: string[] = []
  const CHOICES = /JSON\.stringify\(\{\s*(theme|lang|currency|cardOrder|cardPrecision|chatSound\w*|chatModel|chatHarness|chatEffort|monthlyBudgetUSD)\b/
  for (const file of sources(WEB_SRC)) {
    for (const block of readFileSync(file, 'utf8').split("fetch('/api/preferences'").slice(1)) {
      if (CHOICES.test(block.slice(0, 300))) offenders.push(file)
    }
  }
  expect(offenders).toEqual([])
})
