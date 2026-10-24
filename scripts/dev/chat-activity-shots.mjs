/** Run only inside agentop run --rm. Renders the real components without an API. */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const out = process.env.SHOTS_DIR
if (!out) throw new Error('Set SHOTS_DIR to the evidence directory')
const port = Number(process.env.WEB_PORT || 48731)
if ([47291, 47292].includes(port)) throw new Error('Use a throwaway port')
const base = `http://127.0.0.1:${port}`
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('packages/web'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
})
let browser
let logs = ''
server.stdout.on('data', data => { logs += data })
server.stderr.on('data', data => { logs += data })
const report = []
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/preview/chat-activity/`)).ok) break } catch {}
    if (server.exitCode !== null || i > 120) throw new Error(`Preview failed: ${logs}`)
    await new Promise(r => setTimeout(r, 500))
  }
  await mkdir(out, { recursive: true })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
  for (const width of [1280, 390]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390 })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/preview/chat-activity/?theme=${theme}`, { waitUntil: 'networkidle' })
      await page.locator('[data-activity-icon]').first().waitFor()
      await page.evaluate(() => document.fonts.ready)
      const geometry = await page.locator('[data-case]').evaluateAll(cases => cases.map(row => {
        const icon = row.querySelector('[data-activity-icon]')
        const activity = icon.closest('button')
        const system = row.querySelector('svg.lucide-info').closest('button')
        const a = icon.getBoundingClientRect()
        const s = system.querySelector('svg').getBoundingClientRect()
        const text = activity.querySelector('span[title]').getBoundingClientRect()
        const systemText = system.querySelector('span').getBoundingClientRect()
        return { case: row.dataset.case, iconX: a.x, systemX: s.x, textX: text.x, systemTextX: systemText.x,
          iconWidth: a.width, iconHeight: a.height, touchHeight: activity.getBoundingClientRect().height,
          logoLoaded: [...row.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0) }
      }))
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      for (const row of geometry) {
        if (row.iconX !== row.systemX || row.textX !== row.systemTextX || row.iconWidth !== 14 || row.iconHeight !== 14 || !row.logoLoaded) throw new Error(JSON.stringify({ width, theme, row }))
        if (width === 390 && row.touchHeight < 44) throw new Error('Touch target below 44px')
      }
      if (overflow || errors.length) throw new Error(JSON.stringify({ overflow, errors }))
      await page.screenshot({ path: `${out}/${width}-${theme}.png`, fullPage: true })
      // Interaction: expand and collapse the commands row.
      const toggle = page.locator('[data-case]').first().getByRole('button').first()
      await toggle.click()
      if (await toggle.getAttribute('aria-expanded') !== 'true') throw new Error('Expansion failed')
      await toggle.click()
      // Simulate a failed MCP image: fallback stays in the same 14px slot.
      const mark = page.locator('[data-activity-icon="mcp"]').first()
      await mark.locator('img').evaluate(img => img.dispatchEvent(new Event('error')))
      await mark.locator('svg.lucide-plug').waitFor()
      report.push({ width, theme, overflow, errors, geometry, expansion: 'passed', brokenLogoFallback: 'passed' })
      await page.close()
    }
  }
  await writeFile(`${out}/layout.json`, JSON.stringify(report, null, 2))
  console.log(`4 screenshots and layout assertions passed: ${out}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise(r => server.exitCode === null ? server.once('exit', r) : r())
}
