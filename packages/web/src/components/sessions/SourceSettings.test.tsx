import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SourceSettings } from './SourceSettings'

const controls = (busy: boolean) => ({
  busy,
  effort: { value: 'high', efforts: ['low', 'medium', 'high'] as const, set: async () => null },
  browser: { on: false, set: async () => null },
  extraDirs: { dirs: ['/other/repo'], add: async () => null },
})

describe('SourceSettings — a source\'s own settings in the composer menu', () => {
  test('effort on the EffortPicker scale, the browser switch and the folders', () => {
    const html = renderToStaticMarkup(<SourceSettings controls={controls(false)} pt={false} onRefused={() => {}} />)
    expect(html).toContain('Reasoning')
    for (const l of ['low', 'medium', 'high']) expect(html).toContain(`>${l}<`)
    expect(html).toContain('data-testid="native-browser"')
    expect(html).toContain('/other/repo')
    expect(html).not.toContain('disabled=""')
  })
  test('mid-turn the controls wait (disabled), in PT too', () => {
    const html = renderToStaticMarkup(<SourceSettings controls={controls(true)} pt onRefused={() => {}} />)
    expect(html).toContain('Raciocínio')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-disabled="true"')
  })
  test('a source without settings draws nothing extra', () => {
    expect(renderToStaticMarkup(<SourceSettings controls={{ busy: false }} pt={false} onRefused={() => {}} />)).toBe('<div data-testid="source-settings"></div>')
  })
})
