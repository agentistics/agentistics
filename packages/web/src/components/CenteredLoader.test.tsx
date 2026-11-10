import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CenteredLoader } from './CenteredLoader'

test('a screen loader is centred on the viewport on both axes', () => {
  const html = renderToStaticMarkup(<CenteredLoader testId="surface" />)
  expect(html).toContain('data-testid="surface"')
  expect(html).toContain('data-placement="screen"')
  expect(html).toContain('position:fixed')
  expect(html).toContain('inset:0')
  expect(html).toContain('align-items:center')
  expect(html).toContain('justify-content:center')
})

test('an area loader is centred inside its panel', () => {
  const html = renderToStaticMarkup(<CenteredLoader testId="panel" placement="area" />)
  expect(html).toContain('data-placement="area"')
  expect(html).toContain('height:100%')
  expect(html).toContain('align-items:center')
  expect(html).not.toContain('position:fixed')
})

test('a fill loader never fixes itself to the viewport', () => {
  const html = renderToStaticMarkup(<div style={{ position: 'relative', width: 248, height: 400 }}><CenteredLoader testId="route" placement="fill" /></div>)
  expect(html).toContain('data-placement="fill"')
  expect(html).toContain('position:absolute')
  expect(html).not.toContain('position:fixed')
})

test('route panels provide a positioned flex fill for both sidebar widths', async () => {
  for (const file of ['pages/TasksPage.tsx', 'pages/DeliveryCalendarPage.tsx']) {
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text()
    expect(source).toContain('position: \'relative\'')
    expect(source).toContain('flex: 1')
    expect(source).toContain('minHeight: 0')
  }
  expect(248).toBeGreaterThan(64)
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
