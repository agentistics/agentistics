/** Run under agentop run --rm; browser measurements use the real button, not its wrapper. */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const output = resolve(process.argv[2] ?? '.qa-usage-r2')
await mkdir(output, { recursive: true })
const port = Number(process.env.WEB_PORT ?? 48132)
assert(![47291, 47292].includes(port))
const server = spawn(process.execPath, [resolve('packages/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('packages/web'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
})
let serverLog = ''
server.stdout?.on('data', x => { serverLog += x })
server.stderr?.on('data', x => { serverLog += x })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const evidence: unknown[] = []
try {
  const url = `http://127.0.0.1:${port}/e2e/usage-r2.html`
  let ready = false
  for (let i = 0; i < 300; i++) {
    ready = await fetch(url).then(r => r.ok).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert(ready, serverLog)
  browser = await chromium.launch({ ...(process.env.QA_CHROMIUM ? { executablePath: process.env.QA_CHROMIUM } : {}), headless: true, args: ['--no-sandbox'] })
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/**', route => route.fulfill({ json: {} }))
    await page.goto(url)
    await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme) }, theme)
    const control = page.getByRole('switch').first()
    await control.waitFor()
    const box = await control.boundingBox()
    assert(box && (width !== 390 || box.width >= 44 && box.height >= 44), `interactive target: ${JSON.stringify(box)}`)
    await control.getByText('Agentes', { exact: true }).click()
    assert.equal(await control.getAttribute('aria-checked'), 'false')
    const rail = page.locator('[data-area-rail]')
    await page.locator('#outside').focus()
    await rail.locator('a').first().focus()
    await page.waitForFunction(() => document.querySelector('[data-area-rail]')?.getAttribute('data-open') === 'true')
    assert(await rail.evaluate(el => el.contains(document.activeElement)), 'opening keeps keyboard focus inside')
    await page.locator('#outside').focus()
    await page.waitForFunction(() => document.querySelector('[data-area-rail]')?.getAttribute('data-open') === 'false')
    const date = await page.locator('[data-localized-date]').textContent()
    assert(date?.includes('nov') && !date.includes('Nov'), date ?? '')
    const marker = await page.locator('[data-account-color="gemini:empty"]').evaluate(el => getComputedStyle(el).backgroundColor)
    assert.equal(marker, 'rgb(148, 163, 184)')
    const accountColor = await page.locator('[data-account-color="claude:b"]').evaluate(el => getComputedStyle(el).backgroundColor)
    assert.equal(accountColor, 'rgb(37, 99, 235)')
    await page.getByRole('tab', { name: 'Tudo sobreposto', exact: true }).click()
    await page.locator('.recharts-surface').first().waitFor()
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-usage-chart=limits] svg text')).some(el => /seg|ter|qua|qui|sex|sáb|dom/.test(el.textContent ?? '')))
    const axisText = await page.locator('[data-usage-chart=limits] svg text').allTextContents()
    assert(axisText.some(t => /seg|ter|qua|qui|sex|sáb|dom/.test(t)), 'weekly axis includes day')
    assert(await page.getByRole('heading', { name: 'Uso do limite por hora' }).count())
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow')
    await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true })
    assert.deepEqual(errors, [])
    evidence.push({ width, theme, switch: box, marker, date, axisText })
    await page.close()
  }
  await writeFile(resolve(output, 'measurements.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise<void>(r => { if (server.exitCode !== null) r(); else server.once('exit', () => r()) })
}
