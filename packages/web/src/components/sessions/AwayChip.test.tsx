import { afterEach, describe, expect, test } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AWAY_OFF } from '@agentistics/core'
import { AwayChip, AwayScopeDialog, awayMenuItems } from './AwayChip'
import { ConfirmModal, Select } from '../../pages/settings/primitives'
import { __setAwayForTest } from '../../lib/awayMode'

function withWidth(width: number, run: () => void) {
  const root = globalThis as { window?: unknown }
  const old = root.window
  root.window = { innerWidth: width, matchMedia: () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }) }
  try { run() } finally { if (old === undefined) delete root.window; else root.window = old }
}
function find(node: ReactNode, type: unknown): any {
  let found: any
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return
    if (child.type === type) found = child
    else found ??= find(child.props.children, type)
  })
  return found
}
afterEach(() => __setAwayForTest(null))

describe('session away header indicator', () => {
  test('inheriting the global setting draws nothing in the header', () => {
    withWidth(1440, () => {
      for (const global of [false, true]) {
        __setAwayForTest({ ...AWAY_OFF, on: global })
        for (const away of [false, true]) {
          const html = renderToStaticMarkup(<AwayChip id="managed" away={away} pt={false} />)
          if (global || !away) expect(html).not.toContain('session-away-chip')
        }
      }
    })
  })
  test.each([390, 1440])('an override (own flag ON, global OFF) shows a small moon at width %s', width => {
    withWidth(width, () => {
      for (const pt of [false, true]) {
        const html = renderToStaticMarkup(<AwayChip id="managed" away pt={pt} />)
        expect(html).toContain('role="switch"')
        expect(html).toContain('aria-checked="true"')
        expect(html).toContain(pt ? 'Modo ausente só nesta sessão' : 'Away mode on this session only')
        expect(html).toContain('var(--anthropic-orange)')
        expect(html).not.toContain('>Away<')
        if (width === 390) expect(html).toContain('min-height:44px')
        else expect(html).not.toContain('min-height')
      }
    })
  })
  test('the session menu carries the per-session switch, only for an actionable session', () => {
    const [item] = awayMenuItems({ id: 'x', actionable: true, away: false }, false, false)
    expect(item!.label).toBe('Away mode on this session…'); expect(item!.on).toBe(false)
    expect(awayMenuItems({ id: 'x', actionable: true, away: false }, true, true)[0]!.on).toBe(true)
    expect(awayMenuItems({ id: 'x', actionable: false }, false, false)).toEqual([])
    expect(awayMenuItems(undefined, false, false)).toEqual([])
  })
  test('ON and OFF use the existing confirmation and offer the same two scopes', () => {
    for (const on of [true, false]) for (const pt of [true, false]) {
      let chosen = ''; let confirmed = 0; let cancelled = 0
      const tree = AwayScopeDialog({ pt, open: true, on, scope: 'session', setScope: v => { chosen = v },
        busy: false, error: null, globalActive: false, onConfirm: () => { confirmed++ }, onCancel: () => { cancelled++ } })
      expect(tree.type).toBe(ConfirmModal)
      const select = find(tree, Select)
      expect(select.props.options.map((o: { value: string }) => o.value)).toEqual(['session', 'active'])
      expect(select.props.options.map((o: { label: string }) => o.label)).toEqual(pt
        ? ['Só esta sessão', 'Todas as sessões ativas agora'] : ['Only this session', 'All sessions active now'])
      select.props.onChange('active'); expect(chosen).toBe('active')
      tree.props.onConfirm(); expect(confirmed).toBe(1)
      tree.props.onCancel(); expect(cancelled).toBe(1)
    }
  })
  test.each([390, 1440])('fleet confirmation includes affected count and cooldown at width %s', width => {
    __setAwayForTest(AWAY_OFF, { activeSessions: 7, cooldownMs: 60_000 })
    withWidth(width, () => {
      for (const pt of [true, false]) {
        const html = renderToStaticMarkup(<AwayScopeDialog pt={pt} open on={false} scope="active" setScope={() => {}}
          busy={false} error={null} globalActive={false} onConfirm={() => {}} onCancel={() => {}} />)
        expect(html).toContain(pt ? 'Isto avisa 7 sessões ativas' : 'This notifies 7 active sessions')
        expect(html).toContain(pt ? 'período de espera' : 'cooldown period')
        expect(html).toContain('var(--bg-card)')
        if (width === 390) expect(html).toContain('min-height:44px')
      }
    })
  })
})
