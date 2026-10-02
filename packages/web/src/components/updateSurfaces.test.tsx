/**
 * Two owner rules for the update experience, held over what is actually RENDERED:
 *
 * 1. In the UI, updating is the button only (2026-10-02). No update surface — the popup in the Nay
 *    window, the bell's sheet, the bell entry's text, the loader, the finale — may show or suggest
 *    the CLI path: no `agentop upgrade`, no copy box, no "do it in a terminal". The CLI's own
 *    notices are untouched and are not read here.
 * 2. The logo in the finale animates in SCALE, OPACITY, COLOUR and GLOW only — never its geometry.
 *    The keyframes are read out of `index.css` and may name `transform: scale(...)`, `opacity` and
 *    `filter` and nothing else.
 *
 * Rendering is `renderToStaticMarkup`, the stack the rest of this package's component tests use.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateModal } from './UpdateModal'
import { UpgradeOverlay } from './UpgradeOverlay'
import { UpdateFinale } from './UpdateFinale'
import { NayUpdateCard } from './nay/NayUpdateCard'
import { resetFlow, setFlowForTest, IDLE_FLOW } from '../lib/upgradeFlow'
import { UPDATE_STEPS } from '../lib/updateI18n'
import { UPDATE_STRINGS } from '../lib/updateI18n'
import { resolveNotification } from '../lib/notifications'
import { UPDATE_NOTICE_CODE } from '../lib/updateToast'

const FORBIDDEN = [/agentop\s+upgrade/i, /systemctl/i, /up:central/i, /\$\s*agentop/i, /terminal/i]
const noop = () => {}
const info = { current: '2.30.0', latest: '2.31.0', critical: false }

function rendered(): string[] {
  const out: string[] = []
  for (const lang of ['pt', 'en'] as const) {
    for (const critical of [false, true]) {
      out.push(renderToStaticMarkup(<UpdateModal current="2.30.0" latest="2.31.0" critical={critical} lang={lang} onLater={noop} onClose={noop} />))
      for (const placement of ['dock', 'float', 'corner'] as const)
        out.push(renderToStaticMarkup(<NayUpdateCard lang={lang} isMobile={false} info={{ ...info, critical }} placement={placement} onExit={noop} />))
    }
    for (const step of UPDATE_STEPS) {
      for (const phase of ['running', 'arrived', 'failed', 'timeout'] as const) {
        setFlowForTest({ ...IDLE_FLOW, phase, target: '2.31.0', startedAt: 1, view: { step, fraction: 0.5, failed: phase === 'failed' }, message: null })
        out.push(renderToStaticMarkup(<UpgradeOverlay lang={lang} isMobile={false} />))
      }
    }
    out.push(renderToStaticMarkup(<UpdateFinale lang={lang} version="2.31.0" onDone={noop} />))
    const n = resolveNotification({ id: 'x', type: 'info', code: UPDATE_NOTICE_CODE, meta: { version: '2.31.0' }, read: false, at: '' } as never, lang)
    out.push(`${n.title} ${n.message}`)
  }
  return out
}

afterEach(() => resetFlow())

describe('no update surface suggests the CLI', () => {
  test('nothing rendered names the upgrade command or a terminal', () => {
    const all = rendered()
    expect(all.length).toBeGreaterThan(40)
    for (const html of all) {
      expect(html).not.toContain('agentop upgrade')
      for (const re of FORBIDDEN) expect(html).not.toMatch(re)
    }
  })
  test('every string the flow owns is CLI-free too (including phrases not on screen right now)', () => {
    for (const lang of ['pt', 'en'] as const)
      for (const v of Object.values(UPDATE_STRINGS[lang])) for (const re of FORBIDDEN) expect(v).not.toMatch(re)
  })
  test('the surfaces carry the button', () => {
    const modal = renderToStaticMarkup(<UpdateModal current="2.30.0" latest="2.31.0" lang="en" onLater={noop} onClose={noop} />)
    expect(modal).toContain('Install now')
    expect(modal).toContain('Remind me later')
    const card = renderToStaticMarkup(<NayUpdateCard lang="pt" isMobile info={info} placement="dock" onExit={noop} />)
    expect(card).toContain('Instalar agora')
    expect(card).toContain('v2.30.0 → v2.31.0')
  })
  test('the loader says which step it is on, and an idle flow draws nothing', () => {
    setFlowForTest({ ...IDLE_FLOW, phase: 'running', target: '2.31.0', startedAt: 1, view: { step: 'brain', fraction: 0.6, failed: false }, message: null })
    const html = renderToStaticMarkup(<UpgradeOverlay lang="en" isMobile />)
    expect(html).toContain('data-step="brain"')
    expect(html).toContain('Updating ')
    resetFlow()
    expect(renderToStaticMarkup(<UpgradeOverlay lang="en" isMobile />)).toBe('')
  })
  test('the finale names the version', () => {
    expect(renderToStaticMarkup(<UpdateFinale lang="pt" version="2.31.0" onDone={noop} />)).toContain('Atualizado ')
  })
})

describe('the logo is animated, never redrawn', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  const block = (name: string) => {
    const at = css.indexOf(`@keyframes ${name}`)
    expect(at).toBeGreaterThan(-1)
    let depth = 0, i = css.indexOf('{', at)
    const start = i
    for (; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) break }
    return css.slice(start, i + 1)
  }
  test('only scale, opacity and filter (colour + drop-shadow glow)', () => {
    const body = block('ag-upd-logo')
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1])
    for (const p of props) expect(['transform', 'opacity', 'filter']).toContain(p!)
    for (const t of body.matchAll(/transform:\s*([^;]+);/g)) expect(t[1]!.trim()).toMatch(/^scale\([\d.]+\)$/)
    for (const f of body.matchAll(/filter:\s*([^;]+);/g))
      for (const fn of f[1]!.matchAll(/([a-z-]+)\(/g)) expect(['brightness', 'saturate', 'drop-shadow', 'rgba', 'hue-rotate']).toContain(fn[1]!)
  })
  test('the finale uses the brand raster, not a redrawn mark', () => {
    const html = renderToStaticMarkup(<UpdateFinale lang="en" version="2.31.0" onDone={noop} />)
    expect(html).toContain('<canvas')
    expect(html).not.toContain('<svg')
    // the scene draws the brand raster, square, via drawImage — never a path
    const scene = readFileSync(new URL('../lib/updateScene.ts', import.meta.url), 'utf8')
    expect(scene).toMatch(/drawImage\(logo, cx - s \/ 2, cy - s \/ 2, s, s\)/)
  })
})
