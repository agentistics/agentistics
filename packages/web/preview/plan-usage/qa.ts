/** Run with agentop heavy -- agentop run --rm -- node packages/web/preview/plan-usage/qa.ts. */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const output = resolve('.qa-plan-usage')
await mkdir(output, { recursive: true })
const port = Number(process.env.WEB_PORT ?? 48132)
assert(![47291, 47292].includes(port))
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--config', 'packages/web/preview/plan-usage.vite.config.ts', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
let logs = ''
server.stdout.on('data', x => { logs += x })
server.stderr.on('data', x => { logs += x })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const results: unknown[] = []
try {
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 300; i++) {
    ready = await fetch(url).then(r => r.ok).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert(ready, logs)
  browser = await chromium.launch({ ...(process.env.QA_CHROMIUM ? { executablePath: process.env.QA_CHROMIUM } : {}), headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox'] })
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/**', route => route.fulfill({ json: { items: [] } }))
    await page.goto(url)
    const arrow = page.locator('[data-plan-scroll-more]')
    await arrow.waitFor()
    const metrics = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('[data-plan-usage-scroll]')!
      const card = document.querySelector<HTMLElement>('[data-plan-usage-popover]')!
      const arrow = document.querySelector<HTMLElement>('[data-plan-scroll-more]')!
      const icon = arrow.querySelector('svg')!
      return { rightGutter: card.getBoundingClientRect().right - scroll.getBoundingClientRect().right, scrollbarWidth: scroll.offsetWidth - scroll.clientWidth, arrowBottom: scroll.getBoundingClientRect().bottom - icon.getBoundingClientRect().bottom, pageOverflow: document.documentElement.scrollWidth > innerWidth, before: scroll.scrollTop }
    })
    assert(metrics.rightGutter <= 1.1, JSON.stringify(metrics))
    assert.equal(metrics.scrollbarWidth, 8)
    assert.equal(metrics.arrowBottom, 4)
    assert.equal(metrics.pageOverflow, false)
    await page.screenshot({ path: resolve(output, `${width}-overflow.png`) })
    await page.locator('[data-plan-usage-indicator]').first().screenshot({ path: resolve(output, `${width}-indicator.png`), scale: 'css' })
    await arrow.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-plan-usage-scroll]')!.scrollTop > 0)
    await page.locator('[data-plan-usage-scroll]').evaluate(el => { el.scrollTop = el.scrollHeight })
    await arrow.waitFor({ state: 'detached' })
    await page.mouse.move(width - 5, 700)
    await page.screenshot({ path: resolve(output, `${width}-end.png`) })
    await page.locator('[data-plan-usage-indicator]').last().focus()
    await page.getByRole('tooltip').waitFor()
    assert.equal(errors.length, 0, errors.join('\n'))
    results.push({ width, ...metrics, keyboardScroll: true, hiddenAtEnd: true, focusTooltip: true, errors })
    await page.close()
  }
  await writeFile(resolve(output, 'measurements.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
