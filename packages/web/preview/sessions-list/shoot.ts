// Prints of the sessions list redesign, against the prototype frames. Dev-only.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const base = process.argv[2] ?? 'http://127.0.0.1:47752'
const out = process.env.SHOTS ?? process.env.HOME + '/.agentistics/leader/shots/sessions-list-ad'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const errors: string[] = []
const shots: [string, string, number, number][] = []
for (const theme of ['dark', 'light']) {
  for (const tab of ['active', 'groups', 'ended']) {
    shots.push([`desktop-340-${tab}-${theme}`, `?tab=${tab}&theme=${theme}`, 1180, 820])
    shots.push([`rail-${tab}-${theme}`, `?tab=${tab}&theme=${theme}&rail=1`, 900, 820])
    shots.push([`mobile-390-${tab}-${theme}`, `?tab=${tab}&theme=${theme}`, 390, 844])
  }
  shots.push([`desktop-340-active-folded-motor-${theme}`, `?tab=active&theme=${theme}&fold=motor`, 1180, 820])
  shots.push([`rail-active-folded-motor-${theme}`, `?tab=active&theme=${theme}&rail=1&fold=motor`, 900, 820])
}
for (const [name, query, w, h] of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 })
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: console ${m.text()}`) })
  await page.goto(base + '/' + query)
  await page.waitForTimeout(3000)
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (sw > 0) errors.push(`${name}: horizontal overflow ${sw}px`)
  const ell = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#root *'))
    .filter(el => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth).map(el => el.textContent?.slice(0, 40)))
  if (ell.length) errors.push(`${name}: truncated with ellipsis: ${ell.join(' | ')}`)
  await page.screenshot({ path: `${out}/${name}.png` })
  await page.close()
}
await browser.close()
console.log(errors.length ? errors.join('\n') : 'no errors')
