/**
 * session-surface.lint.test.ts — LIVE C1: SESSION_SURFACE and `planSessionSource` are read ONLY by the
 * session surfaces. The importer set is EXACT (the `tokens.lint.test.ts` shape): a metric module —
 * `/api/data`, the derived stats, the MCP analytics tools, `runtime-metrics-*` — that starts importing
 * them fails the build, as does a new importer nobody listed here.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SERVER = join(import.meta.dir, '..')
const PACKAGES = join(SERVER, '..', '..')

function* sources(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* sources(p)
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) yield p
  }
}

/** Files (relative to packages/) whose import specifiers name one of the LIVE.2 modules. */
function importers(): string[] {
  const out: string[] = []
  for (const f of sources(PACKAGES)) {
    const text = readFileSync(f, 'utf8')
    if (/from\s+['"][^'"]*\/(session-surface|session-source|session-surface-reader|session-surface-deps)['"]/.test(text)
      || /import\(\s*['"][^'"]*\/(session-surface|session-source|session-surface-reader|session-surface-deps)['"]\s*\)/.test(text)) {
      out.push(relative(PACKAGES, f))
    }
  }
  return out.sort()
}

describe('C1 — metrics keep the legacy readers', () => {
  test('the importers of the LIVE.2 modules are exactly the chat route, the session surfaces and the projection catalogue', () => {
    expect(importers()).toEqual([
      'server/server/index.ts',
      'server/server/projections/catalog.ts',
      'server/server/projections/session-surface-reader.ts',
      'server/server/sessions/chat-web.ts',
      'server/server/sessions/session-surface-deps.ts',
    ])
  })

  test('the server route reaches them only through the deps factory, and no metric module names them', () => {
    const index = readFileSync(join(SERVER, 'index.ts'), 'utf8')
    expect(index).toContain('liveSessionSurfaceDeps')
    for (const f of ['data.ts', 'runtime-metrics-query.ts']) {
      expect(readFileSync(join(SERVER, f), 'utf8')).not.toMatch(/session-surface-reader|session-source|readSessionSurface/)
    }
  })
})
