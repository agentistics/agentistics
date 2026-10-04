import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { TAB_ORDER } from './types'

/**
 * GL-07: every tab, rendered for real, fits the terminal it is drawn for.
 *
 * Each frame is drawn by `scripts/preview.tsx` — the dev tool that renders the WHOLE control center
 * through `ink-testing-library` against its fake host (the same fake the screens are looked at
 * with), measures every row against the width and the frame against the height, and exits non-zero
 * when either overflows. Run as a subprocess so the fake host is the one the preview owns (a copy
 * here would be a second fake to drift) and so `process.stdout`'s size, which `useTerminalSize`
 * reads, is set per frame instead of for the whole test process.
 *
 * On top of the preview's own ✓/✗: at 80 columns the three cockpits must show ONE pane at a time
 * (D-TUI-10) — no row may carry two pane tops side by side, and the pane strip must be there.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const PREVIEW = join(ROOT, 'packages', 'tui', 'scripts', 'preview.tsx')

interface Frame {
  code: number
  out: string
}

async function frame(tab: string, cols: number, rows: number, lang: string): Promise<Frame> {
  const proc = Bun.spawn(
    ['bun', 'run', PREVIEW, '--cols', String(cols), '--rows', String(rows), '--screen', tab, '--lang', lang],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: out + err }
}

/** Bounded parallelism — the machine this runs on is shared with the rest of the suite. */
async function all<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const SIZES = [[80, 24], [108, 36]] as const
const COCKPITS = new Set(['services', 'sessions', 'backup'])

describe('every tab fits its terminal (GL-07)', () => {
  test('80x24 and 108x36, EN and PT: no row wraps, the frame never overflows, narrow shows one pane', async () => {
    const cases = TAB_ORDER.flatMap(tab => SIZES.flatMap(([cols, rows]) => (['en', 'pt'] as const).map(lang => ({ tab, cols, rows, lang }))))
    const frames = await all(cases, 4, c => frame(c.tab, c.cols, c.rows, c.lang))
    const failures: string[] = []
    frames.forEach((f, i) => {
      const c = cases[i]!
      const id = `${c.tab} ${c.cols}x${c.rows} ${c.lang}`
      if (f.code !== 0) failures.push(`${id}: ${f.out.split('\n').filter(l => l.includes('✗')).join(' | ') || `exit ${f.code}`}`)
      if (c.cols < 100 && COCKPITS.has(c.tab)) {
        const sideBySide = f.out.split('\n').filter(l => (l.match(/╭/g) ?? []).length > 1)
        if (sideBySide.length > 0) failures.push(`${id}: two panes side by side on a narrow terminal`)
        // The strip is a line holding the three pane names and nothing else.
        if (!f.out.split('\n').some(l => /^\s+[^\s·│╭]+ · [^\s·]+ · [^\s·]+\s*$/.test(l))) failures.push(`${id}: no pane strip`)
      }
    })
    expect(failures).toEqual([])
  }, 120_000)
})
