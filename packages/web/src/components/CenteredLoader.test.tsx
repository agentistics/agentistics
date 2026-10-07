import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CenteredLoader } from './CenteredLoader'

test('centered loader uses both axes and fills its loading surface', () => {
  const html = renderToStaticMarkup(<CenteredLoader testId="surface" />)
  expect(html).toContain('data-testid="surface"')
  expect(html).toContain('display:flex')
  expect(html).toContain('align-items:center')
  expect(html).toContain('justify-content:center')
  expect(html).toContain('min-height:100%')
})

test('fixed loading surfaces all use the shared centering container', async () => {
  const files = [
    ['AppRouter.tsx', 'route-loading'],
    ['pages/VaultPage.tsx', 'vault-loading'],
    ['pages/settings/ProvidersSettings.tsx', 'providers-loading'],
    ['pages/settings/HarnessesSettings.tsx', 'harnesses-loading'],
    ['pages/settings/MemorySettings.tsx', 'memory-loading'],
    ['pages/TasksPage.tsx', 'agentask-loading'],
    ['pages/TagDetailPage.tsx', 'tag-loading'],
    ['pages/settings/PricingSettings.tsx', 'pricing-loading'],
    ['components/sessions/SessionChat.tsx', 'session-chat-loading'],
  ] as const
  for (const [file, testId] of files) {
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text()
    expect(source).toContain(`testId="${testId}"`)
    expect(source).toContain('<CenteredLoader')
  }
})
