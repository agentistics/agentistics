import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeModelSwitch } from './NativeModelSwitch'

// `ModelSelect` reads `window.innerWidth` (useIsMobile). A bare one for these renders, removed after
// when this file created it — left behind it would make another file's `typeof window` guard true.
const env = globalThis as unknown as { window?: { innerWidth: number } }
const windowIsOurs = env.window === undefined
env.window ??= { innerWidth: 1280 }
afterAll(() => { if (windowIsOurs) delete env.window })

describe('H24: the model switch in the native chat', () => {
  test('shows the session\'s model; disabled while a run is in flight', () => {
    const idle = renderToStaticMarkup(<NativeModelSwitch model="claude-haiku-4-5" provider="anthropic" running={false} lang="en" onSwitch={async () => null} />)
    expect(idle).toContain('claude-haiku-4-5')
    expect(idle).toContain('aria-disabled="false"')
    const busy = renderToStaticMarkup(<NativeModelSwitch model="claude-haiku-4-5" provider="anthropic" running lang="pt" onSwitch={async () => null} />)
    expect(busy).toContain('aria-disabled="true"')
    expect(busy).toContain('troque o modelo quando ela terminar')
  })
})
