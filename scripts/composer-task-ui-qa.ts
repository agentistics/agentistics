/** Component evidence in Chromium. Run via agentop heavy -- agentop run --rm. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

assert(process.env.HOME?.includes('agentistics-throwaway'), 'Use agentop run --rm')
const cwd = resolve(import.meta.dir, '..')
const output = join(cwd, '.superpowers/qa/composer-task-popup')
await mkdir(output, { recursive: true })
const port = Number(process.env.WEB_PORT ?? 48164)
assert(![47291, 47292].includes(port))
const server = await createServer({ configFile: false, root: join(cwd, 'packages/web'), plugins: [react(), {
  name: 'composer-task-qa-page', configureServer(vite) {
    vite.middlewares.use('/__composer-task-qa', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/__composer-task-qa', `<html data-glass="on"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${cwd}/packages/web/preview/composer-task-popup.tsx"></script></body></html>`))
    })
  },
}],
  resolve: { alias: { '@agentistics/core': join(cwd, 'packages/core/src/index.ts') } },
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [cwd] } },
})
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.COMPOSER_QA_CHROMIUM ? { executablePath: process.env.COMPOSER_QA_CHROMIUM } : {}), args: ['--no-sandbox'] })
const evidence: unknown[] = []
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'pt-BR' })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${port}/__composer-task-qa`)
    const trigger = page.locator('[data-composer-task-trigger]')
    await trigger.waitFor()
    await page.screenshot({ animations: 'disabled', path: join(output, `${width}-closed.png`) })
    await trigger.hover()
    await page.getByRole('tooltip').waitFor()
    await page.screenshot({ animations: 'disabled', path: join(output, `${width}-tooltip.png`) })
    await trigger.click()
    const panel = page.locator('[data-composer-task-popover]')
    await panel.waitFor()
    await page.screenshot({ animations: 'disabled', path: join(output, `${width}-calendar-today-green.png`) })
    await panel.getByRole('button', { name: 'Hoje', exact: true }).click()
    assert.equal(await panel.locator('[aria-current="date"]').getAttribute('aria-pressed'), 'true')
    await panel.getByRole('button', { name: 'Próximo mês', exact: true }).click()
    await panel.getByRole('button', { name: 'Mês anterior', exact: true }).click()
    const selectedDay = new Date().getDate() === 15 ? '16' : '15'
    await panel.locator(`button[aria-label$="-${selectedDay}"]`).click()
    await panel.locator('input[type="time"]').fill('14:35')
    for (const priority of ['Urgent', 'High', 'Medium', 'Low']) {
      await panel.locator('button[title="Prioridade"]').click()
      await page.locator('[data-chip-select-panel]').getByRole('button', { name: priority, exact: true }).click()
      await page.mouse.move(width - 4, 10)
      await page.screenshot({ animations: 'disabled', path: join(output, `${width}-${priority.toLowerCase()}.png`) })
    }
    if (width === 390) {
      const target = await panel.locator('button[aria-current="date"]').boundingBox()
      assert(target && target.width >= 44 && target.height >= 44, 'Mobile calendar days need 44px touch targets')
    }
    const geometry = await panel.evaluate(el => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scroll: document.documentElement.scrollWidth, viewport: innerWidth, backdrop: getComputedStyle(el).backdropFilter, timeFont: getComputedStyle(el.querySelector('input')!).fontSize }
    })
    assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0)
    assert(geometry.scroll <= width)
    assert(geometry.backdrop.includes('blur'))
    if (width === 390) assert(parseFloat(geometry.timeFont) >= 16)
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    assert.equal(await trigger.getAttribute('aria-pressed'), 'true')
    assert.equal(await trigger.evaluate(el => getComputedStyle(el).borderStyle), 'none')
    assert.deepEqual(errors, [])
    evidence.push({ width, ...geometry, errors })
    await page.close()
  }
  console.log(JSON.stringify({ result: 'PASS', output, evidence }, null, 2))
} finally { await browser.close(); await server.close() }
