import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A SURFACE that forgets a harness is the bug this guard exists for — and it has happened twice.
 *
 * First as plain arrays: five places hardcoded `['claude', 'codex', …]`, TypeScript accepted a member
 * missing, and a new harness vanished from Compare, the filter bar and the consolidate store while the
 * build stayed green (CLAUDE.md, "Adding a harness", step 3). Then as the WRONG registry: the native
 * Agentistics harness has no adapter, so it is deliberately absent from `HarnessId`/`HARNESS_ORDER`
 * (the ADAPTER set — what has a transcript, a spawn spec, a backup directory) and present in
 * `SurfaceHarnessId`/`SURFACE_HARNESS_ORDER` (every harness a SCREEN may show). A surface that reached
 * for the adapter list compiled perfectly and left the native harness out of the filters, Compare and
 * the MCP enums — "it appears nowhere", in the owner's words.
 *
 * So, a grep over the repo's own source, the shape `tokens.lint.test.ts` uses:
 *
 *  1. In a SURFACE package (web, tui, mcp), `HARNESS_ORDER` and `Record<HarnessId, …>` are refused —
 *     a surface enumerates `SURFACE_HARNESS_ORDER` and keys its tables by `SurfaceHarnessId`.
 *  2. Anywhere, an array LITERAL of two or more harness ids is refused — the registry is the list.
 *
 * Both have an escape hatch, because both are sometimes right: a surface that genuinely talks about
 * ADAPTERS (the backup harness picker, a transcript reader table, a subscription plan) says so with
 * `@harness-adapters-only` and a reason, on the line or in the comment just above it.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const SURFACES = ['packages/web/src', 'packages/tui/src', 'packages/mcp']
const EVERYWHERE = ['packages/core/src', 'packages/server/server', ...SURFACES]
const MARKER = '@harness-adapters-only'
const IDS = '(?:claude|codex|gemini|copilot|antigravity|kimi|opencode|agentistics)'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      // Tests pin lists on purpose — an expected list IS how a registry is checked.
      if (/\.test\.tsx?$/.test(name)) continue
      if (name.endsWith('.generated.ts')) continue
      out.push(p)
    }
  }
  walk(join(ROOT, dir))
  return out
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** The marker on the line or within the six above it (a reason is prose, and prose wraps). */
function excused(lines: string[], n: number): boolean {
  return lines.slice(Math.max(0, n - 7), n).some(l => l.includes(MARKER))
}

function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

interface Hit { file: string; line: number; text: string }

function scan(dirs: readonly string[], pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n')
      for (const m of src.matchAll(pattern)) {
        const n = lineAt(src, m.index ?? 0)
        const text = lines[n - 1] ?? ''
        if (isComment(text) || excused(lines, n)) continue
        hits.push({ file: relative(ROOT, file), line: n, text: text.trim() })
      }
    }
  }
  return hits
}

const fmt = (hits: Hit[]) => hits.map(h => `${h.file}:${h.line}  ${h.text}`).join('\n')

describe('harness registry — no surface forgets a harness', () => {
  it('a surface package never enumerates the ADAPTER list (HARNESS_ORDER) without saying why', () => {
    // `(?<!SURFACE_)` so the surface registry itself is never a hit.
    const hits = scan(SURFACES, /(?<![A-Z_])HARNESS_ORDER\b/g)
    expect(fmt(hits)).toBe('')
  })

  it('a surface package never keys a table by the ADAPTER id (Record<HarnessId, …>) without saying why', () => {
    const hits = scan(SURFACES, /Record<\s*HarnessId\s*,/g)
    expect(fmt(hits)).toBe('')
  })

  it('no source hardcodes a list of harness ids — the registry is the list', () => {
    const literal = new RegExp(`\\[\\s*['"]${IDS}['"]\\s*,\\s*['"]${IDS}['"]`, 'g')
    const hits = scan(EVERYWHERE, literal)
    expect(fmt(hits)).toBe('')
  })

  it('the guard can see: a planted breach in each shape is caught', () => {
    // A guard that matches nothing passes forever. These are the three shapes, as the scanner reads them.
    expect(/(?<![A-Z_])HARNESS_ORDER\b/.test('for (const h of HARNESS_ORDER)')).toBe(true)
    expect(/(?<![A-Z_])HARNESS_ORDER\b/.test('for (const h of SURFACE_HARNESS_ORDER)')).toBe(false)
    expect(/Record<\s*HarnessId\s*,/.test('const X: Record<HarnessId, string> = {')).toBe(true)
    expect(new RegExp(`\\[\\s*['"]${IDS}['"]\\s*,\\s*['"]${IDS}['"]`).test("const hs = ['claude', 'agentistics']")).toBe(true)
  })
})
