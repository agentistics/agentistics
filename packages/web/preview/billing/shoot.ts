// Dev-only: screenshots every preview variant into ~/.agentistics/leader/shots/billing-simple. Run from the repo root with the preview server on :5391.
import { chromium } from 'playwright'
const out = process.env.HOME + '/.agentistics/leader/shots/billing-simple'
const only = process.argv[2]
const views = (only ? only.split(',') : ['before', 'A', 'B', 'C'])
const browser = await chromium.launch()
const errors: string[] = []
for (const view of views) for (const n of [1, 3]) for (const theme of ['dark', 'light']) for (const [dev, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
  for (const drawer of view === 'A' ? [0, 1] : [0]) {
    if (drawer && n === 1 && dev === 'mobile' && theme === 'light') continue
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dev === 'mobile' ? 2 : 1 })
    page.on('pageerror', e => errors.push(`${view} ${n} ${theme} ${dev}: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`${view} ${n} ${theme} ${dev}: console ${m.text()}`) })
    await page.goto(`http://127.0.0.1:5391/?view=${view}&n=${n}&theme=${theme}${drawer ? '&drawer=1' : ''}`)
    await page.waitForTimeout(1500)
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (sw > 0) errors.push(`${view} ${n} ${theme} ${dev}: horizontal overflow ${sw}px`)
    await page.screenshot({ path: `${out}/${view}${drawer ? '-drawer' : ''}-${n}acc-${dev}-${theme}.png`, fullPage: !drawer })
    await page.close()
  }
}
await browser.close()
console.log(errors.length ? errors.join('\n') : 'no errors')
