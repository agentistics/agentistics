import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeEffortSwitch } from './NativeEffortSwitch'
import { NativeReasoning } from './NativeReasoning'

describe('B9.1: reasoning in the native chat', () => {
  test('the effort switch shows the session\'s level; disabled while a run is in flight', () => {
    const idle = renderToStaticMarkup(<NativeEffortSwitch effort="high" running={false} lang="en" onSet={async () => null} />)
    expect(idle).toContain('value="high" selected=""')
    expect(idle).not.toContain('disabled=""')
    const busy = renderToStaticMarkup(<NativeEffortSwitch effort="off" running lang="pt" onSet={async () => null} />)
    expect(busy).toContain('disabled=""')
    expect(busy).toContain('desligado')
  })
  test('the reasoning block: open while it streams, folded once written', () => {
    expect(renderToStaticMarkup(<NativeReasoning text="plan" live lang="en" />)).toContain('open=""')
    const done = renderToStaticMarkup(<NativeReasoning text="plan" lang="pt" />)
    expect(done).not.toContain('open=""')
    expect(done).toContain('Raciocínio')
    expect(done).toContain('plan')
  })
})
