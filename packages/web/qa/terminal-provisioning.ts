/** Isolated real-component UI check. Run with agentop run --rm -- bun packages/web/qa/terminal-provisioning.ts. */
import { chromium } from 'playwright'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const temp = await mkdtemp(join(root, '.terminal-qa-'))
const output = resolve(process.argv[2] ?? 'docs/media/terminal-provisioning')
await mkdir(output, { recursive: true })
await Bun.write(join(temp, 'index.html'), '<div id="root"></div><script type="module" src="./main.tsx"></script>')
await Bun.write(join(temp, 'main.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShellBand } from '/packages/web/src/components/sessions/ShellBand.tsx';
import '/packages/web/src/index.css';
Object.defineProperty(window, 'WebSocket', { value: undefined });
createRoot(document.getElementById('root')!).render(<div style={{height:'100dvh',display:'flex',flexDirection:'column',padding:12,boxSizing:'border-box'}}><ShellBand sessionId="qa-session" cwd="/qa/project" lang="pt" theme="dark" placement="dedicated" fixedTarget="shell" shellEnabled /></div>);
`)
const server = await createServer({ configFile: false, root, plugins: [react()], server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 48103), strictPort: true }, resolve: { alias: { '@agentistics/core': join(root, 'packages/core/src/index.ts') } } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_CHROMIUM })
  const evidence = []
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/shell/list?*', async route => {
      await new Promise(resolve => setTimeout(resolve, 600))
      await route.fulfill({ json: { shells: [] } })
    })
    await page.route('**/api/shell/open?*', async route => {
      await new Promise(resolve => setTimeout(resolve, 600))
      await route.fulfill({ json: { ok: true, shell: { id: 'qa-shell', cwd: '/qa/project' } } })
    })
    // Keep the first frame pending: feedback must span BOTH HTTP requests and SSE wait.
    await page.route('**/api/shell/stream?*', async route => {
      await new Promise(resolve => setTimeout(resolve, 12_000))
      await route.fulfill({ status: 503 })
    })
    await page.goto(`http://127.0.0.1:${server.config.server.port}/${temp.split('/').pop()}/index.html`)
    const loader = page.getByText('Provisionando terminal…', { exact: true })
    await loader.waitFor({ state: 'visible' })
    await page.waitForTimeout(1800)
    if (!await loader.isVisible()) throw new Error('loader disappeared before first frame')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    if (overflow || errors.length) throw new Error(JSON.stringify({ width, overflow, errors }))
    await page.screenshot({ path: join(output, `terminal-provisioning-${width}.png`) })
    await page.getByRole('button', { name: 'Tentar de novo', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    if (await loader.isVisible()) throw new Error('loader remained after stream timeout')
    await page.unroute('**/api/shell/stream?*')
    await page.route('**/api/shell/stream?*', route => route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: frame\ndata: ' + JSON.stringify({ seq: 1, content: 'shell-ok', cols: 80, rows: 24, cursor: { x: 0, y: 1 }, alive: true, lines: 1, historyLimit: 2000, truncated: false }) + '\n\n',
    }))
    await page.getByRole('button', { name: 'Tentar de novo', exact: true }).click()
    await loader.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => performance.getEntriesByName('terminal:first-frame').length > 0)
    const firstFrameMeasured = true
    evidence.push({ width, overflow, errors, loaderThroughFirstFrameWait: true, retryAfterStreamTimeout: true, hiddenAfterFirstFrame: true, firstFrameMeasured })
    await page.close()
  }
  await Bun.write(join(output, 'ui-results.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  await browser?.close()
  await server.close()
  await rm(temp, { recursive: true, force: true })
}
