/**
 * FLUXO.AVISOS 10 — prints of a QUEUED message's caption actions ("Enviar agora" / "Interromper"), in Chromium AND WebKit,
 * at 1280 and 390 wide. It drives `preview/queued-actions` (the real ChatBubble over the real pure rule) and ends by itself.
 *
 *   agentop run --rm -- bash -c 'cd packages/web && node ./e2e/queued-actions.ts ./evidence'
 *
 * The caller starts the preview server (see the README line below) and passes its origin in QA_ORIGIN:
 *   QA_ORIGIN=http://127.0.0.1:$WEB_PORT   PLAYWRIGHT_BROWSERS_PATH=<a cache that holds chromium and webkit>
 * Nothing here binds a port, reads a real session or touches the real vault.
 */
import { chromium, webkit } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? './evidence'
const origin = process.env.QA_ORIGIN
if (!origin) { console.error('QA_ORIGIN is required (the preview server origin)'); process.exit(2) }
mkdirSync(out, { recursive: true })

type Expect = { sendNow: boolean; interrupt: boolean }
const scenarios: Array<{ name: string; query: string; expect: Expect }> = [
  { name: 'claude-working', query: 'harness=claude&working=1', expect: { sendNow: true, interrupt: true } },
  { name: 'claude-two-queued', query: 'harness=claude&working=1&many=1', expect: { sendNow: true, interrupt: true } },
  { name: 'codex-working', query: 'harness=codex&working=1', expect: { sendNow: false, interrupt: true } },
  { name: 'claude-idle', query: 'harness=claude&working=0', expect: { sendNow: false, interrupt: false } },
  { name: 'claude-dialog-open', query: 'harness=claude&working=1&dialog=1', expect: { sendNow: false, interrupt: false } },
  { name: 'claude-working-light-en', query: 'harness=claude&working=1&theme=light&lang=en', expect: { sendNow: true, interrupt: true } },
]
const viewports = [{ label: '1280', width: 1280, height: 800, scale: 1 }, { label: '390', width: 390, height: 844, scale: 2 }]

const problems: string[] = []
const report: unknown[] = []
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  const browser = await engine.launch(process.env.QA_CHROMIUM && engineName === 'chromium' ? { executablePath: process.env.QA_CHROMIUM } : {})
  try {
    for (const vp of viewports) {
      for (const sc of scenarios) {
        const tag = `${engineName}-${vp.label}-${sc.name}`
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale })
        page.on('pageerror', e => problems.push(`${tag}: ${e.message}`))
        page.on('console', m => { if (m.type() === 'error') problems.push(`${tag}: console ${m.text()}`) })
        await page.goto(`${origin}/?${sc.query}`)
        await page.waitForSelector('[role="status"]', { timeout: 15_000 })
        await page.waitForTimeout(300)
        const sendNow = await page.locator('[data-testid="queued-send-now"]').count()
        const interrupt = await page.locator('[data-testid="queued-interrupt"]').count()
        if ((sendNow > 0) !== sc.expect.sendNow) problems.push(`${tag}: send-now ${sendNow > 0 ? 'shown' : 'hidden'}, expected ${sc.expect.sendNow ? 'shown' : 'hidden'}`)
        if ((interrupt > 0) !== sc.expect.interrupt) problems.push(`${tag}: interrupt ${interrupt > 0 ? 'shown' : 'hidden'}, expected ${sc.expect.interrupt ? 'shown' : 'hidden'}`)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (overflow > 0) problems.push(`${tag}: horizontal overflow ${overflow}px`)
        // A press runs the verb it names (the preview records it on window.__ran) — one click per shown action.
        const ran: string[] = []
        if (sendNow > 0) { await page.locator('[data-testid="queued-send-now"]').first().click(); ran.push('sendNow') }
        if (interrupt > 0) { await page.locator('[data-testid="queued-interrupt"]').first().click(); ran.push('interrupt') }
        const recorded = await page.evaluate(() => (window as unknown as { __ran?: string[] }).__ran ?? [])
        if (JSON.stringify(recorded) !== JSON.stringify(ran)) problems.push(`${tag}: pressed ${JSON.stringify(ran)} but ran ${JSON.stringify(recorded)}`)
        report.push({ tag, sendNow, interrupt, overflow })
        await page.screenshot({ path: join(out, `${tag}.png`), fullPage: true })
        await page.close()
      }
    }
  } finally { await browser.close() }
}
writeFileSync(join(out, 'measurements.json'), JSON.stringify({ report, problems }, null, 2))
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : `ok — ${report.length} prints in ${out}`)
process.exit(problems.length ? 1 : 0)
