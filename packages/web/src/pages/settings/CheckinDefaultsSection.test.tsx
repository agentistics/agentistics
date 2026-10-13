import { afterEach, describe, expect, test } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import CheckinDefaultsSection from './CheckinDefaultsSection'
import { CheckinConfigControls } from '../../components/sessions/CheckinConfigControls'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { Select } from './primitives'
import { buildCheckinPatch, checkinDefaults, saveCheckinDefaults, type CheckinConfig } from '../../lib/checkin'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

// Select reaches for `useIsMobile()`, and static markup has no window (same stub as primitives.test).
const withWindow = (fn: () => string): string => {
  const g = globalThis as { window?: unknown }
  const had = 'window' in g
  if (!had) g.window = { innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
  try { return fn() } finally { if (!had) delete g.window }
}

describe('leader check-in defaults in Settings', () => {
  test.each([false, true])('renders the section and shared controls in pt/en (mobile=%s)', isMobile => {
    for (const pt of [false, true]) {
      const html = withWindow(() => renderToStaticMarkup(<CheckinDefaultsSection pt={pt} isMobile={isMobile} />))
      expect(html).toContain(pt ? 'Check-in dos líderes' : 'Leader check-ins')
      expect(html).toContain(pt ? 'Habilitar check-in' : 'Enable check-in')
      expect(html).toContain(pt ? 'líderes atuais mantêm suas escolhas' : 'current leaders keep their choices')
      expect(html.match(/role="switch"/g)).toHaveLength(7)
      expect(html).toContain('disabled=""')
      expect(html).toContain('aria-haspopup="listbox"')
      expect(html).not.toContain('<select')
      if (isMobile) expect(html).toContain('min-height:44px')
    }
  })

  test('shared interval, enabled and checklist handlers save only the global preference', async () => {
    let config = checkinDefaults()
    const requests: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response('{}')
    }) as unknown as typeof fetch
    const pending: Promise<void>[] = []
    const update = async (patch: Partial<CheckinConfig>) => {
      const next = buildCheckinPatch(config, patch)
      await saveCheckinDefaults(next)
      config = next
    }
    const tree = () => CheckinConfigControls({ config, pt: false, isMobile: false, global: true,
      update: patch => { const promise = update(patch); pending.push(promise); return promise } })
    function find(node: ReactNode, predicate: (element: any) => boolean): any {
      let found: any
      Children.forEach(node, child => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return
        if (predicate(child)) found = child
        else found ??= find(child.props.children, predicate)
      })
      return found
    }
    const interval = find(tree(), node => node.type === Select)
    expect(interval.props.value).toBe('30')
    expect(interval.props.options.map((option: { value: string }) => option.value)).toEqual(['15', '30', '60', '120'])
    interval.props.onChange('60')
    await Promise.all(pending)
    find(tree(), node => node.type === ToggleSwitch && node.props.label === 'Enable check-in').props.onToggle()
    await Promise.all(pending)
    find(tree(), node => node.type === ToggleSwitch && node.props.label === 'Sessions and memory').props.onToggle()
    await Promise.all(pending)
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.url).toBe('/api/preferences')
      expect(request.init.method).toBe('PUT')
      expect(Object.keys(JSON.parse(String(request.init.body)))).toEqual(['checkinDefaults'])
    }
    const saved = JSON.parse(String(requests[2]!.init.body)).checkinDefaults
    expect(saved.intervalMin).toBe(60)
    expect(saved.paused).toEqual({ until: null })
    expect(saved.checklist.find((item: any) => item.id === 'fleet').enabled).toBe(false)
    expect(saved.checklist).toHaveLength(6)
  })

  test('failed saves reject instead of reporting success', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(saveCheckinDefaults(checkinDefaults())).rejects.toThrow('save failed')
  })

  test('absent and malformed defaults use the complete built-in agenda', () => {
    const expected = checkinDefaults()
    for (const value of [undefined, null, 'invalid', { intervalMin: 1, checklist: [null], paused: { until: 1 } }]) {
      expect(checkinDefaults(value)).toEqual(expected)
    }
  })
})
