/** Browser proof (Chromium + WebKit, 1280 and 390): the rows say what ran, the reasoning line animates, Enter chords send. */
import { chromium, webkit } from 'playwright'
import { mkdirSync } from 'node:fs'
const base = process.argv[2] ?? 'http://127.0.0.1:47753'
const out = process.env.SHOTS ?? '/tmp/ocprobe/shots'
mkdirSync(out, { recursive: true })
const errors: string[] = []
const check = (name: string, ok: boolean, what: string) => { if (!ok) errors.push(`${name}: ${what}`) }
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]] as const) {
  // A throwaway HOME hides the browsers' cache: point at them with CHROME / WEBKIT (the WebKit one is playwright's pw_run.sh).
  const executablePath = engine === 'chromium' ? process.env.CHROME : process.env.WEBKIT
  const browser = await type.launch(executablePath ? { executablePath } : {})
  for (const [w, h] of [[1280, 800], [390, 844]] as const) {
    const name = `${engine}-${w}`
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 })
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
    await page.goto(base + '/')
    await page.waitForSelector('[data-testid="composer"]')
    const text = (c: string) => page.locator(`[data-case="${c}"]`).innerText()
    // QA HIGH-1 / MED-1 on the REAL recorded turns: one step (no ghost), the notice kept, in order; the output opens on demand.
    const order = async (c: string) => page.locator(`[data-case="${c}"] [data-item]`).evaluateAll(els => els.map(e => (e as HTMLElement).dataset.item))
    const mid = await text('real-mid')
    check(name, /1 passo/.test(mid) && !/2 passos/.test(mid), 'real-mid: the running command is not exactly one step')
    check(name, /Sem resposta do OpenCode há 15 s/.test(mid), 'real-mid: the quiet notice is missing')
    check(name, JSON.stringify(await order('real-mid')) === JSON.stringify(['user', 'activity', 'assistant']), `real-mid order ${JSON.stringify(await order('real-mid'))}`)
    await page.locator('[data-case="real-mid"] button[aria-label*="saída"]').first().click()
    check(name, /start-out/.test(await page.locator('[data-case="real-mid"] [data-testid="tool-output"]').innerText()), 'real-mid: output does not open')
    const end = await text('real-end')
    check(name, /1 passo · 1 falhou/.test(end), 'real-end: not one failed step')
    check(name, JSON.stringify(await order('real-end')) === JSON.stringify(['user', 'activity', 'assistant', 'assistant']), `real-end order ${JSON.stringify(await order('real-end'))}`)
    check(name, end.indexOf('Sem resposta') < end.indexOf('It printed'), 'real-end: the notice is not before the answer')
    check(name, (await page.locator('[data-case="real-end"] [data-testid="tool-output"]').count()) === 0, 'real-end: output must start collapsed')
    await page.locator('[data-case="real-end"] button[aria-expanded]').first().click() // open the activity line
    await page.locator('[data-case="real-end"] button[aria-label*="saída"]').first().click()
    check(name, /hello-out[\s\S]*nonexistent-dir/.test(await page.locator('[data-case="real-end"] [data-testid="tool-output"]').innerText()), 'real-end: full output does not open')
    check(name, /Executando|Executou|comando/i.test(await text('running')) || /sleep 3/.test(await text('running')), 'running row does not name the command or a run')
    const runningTxt = await text('running')
    check(name, !/^execute/m.test(runningTxt.split('\n').slice(1).join('\n')) || /sleep/.test(runningTxt), 'running row still says only "execute"')
    check(name, /Raciocinando… · \d+ s/.test(await text('reasoning-live')), 'live reasoning label')
    check(name, /Raciocinou · 18 s/.test(await text('reasoning-done')), 'done reasoning label')
    const t0 = await text('reasoning-live'); await page.waitForTimeout(2200); const t1 = await text('reasoning-live')
    check(name, t0 !== t1, 'live reasoning seconds do not tick')
    check(name, (await page.locator('[data-case="reasoning-live"] .ag-reasoning-pulse').count()) === 1, 'brain does not pulse')
    await page.locator('[data-case="reasoning-done"] button').click()
    check(name, /Vou conferir/.test(await text('reasoning-done')), 'done reasoning does not open')
    const ta = page.locator('[data-testid="composer"]')
    await ta.click(); await ta.fill('oi'); await ta.press('Enter')
    const afterEnter = await page.locator('[data-testid="log"]').innerText()
    await ta.fill('oi 2'); await ta.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    const afterChord = await page.locator('[data-testid="log"]').innerText()
    check(name, /sent: oi 2/.test(afterChord), 'Ctrl/Cmd+Enter did not send')
    if (w === 1280) check(name, /sent: oi\b/.test(afterEnter), 'plain Enter did not send on the desktop layout')
    else check(name, !/sent: oi\b/.test(afterEnter), 'plain Enter sent on the touch layout (must break the line)')
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(name, sw <= 0, `horizontal overflow ${sw}px`)
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
    await page.close()
  }
  // WebKit's close can hang under WSL after the last page: bounded, it never holds the result back.
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))])
}
console.log(errors.length ? errors.join('\n') : 'no errors')
process.exit(errors.length ? 1 : 0)
