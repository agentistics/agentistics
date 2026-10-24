/** Run with: agentop run --rm -- node packages/web/e2e/vault-expiry-nay.ts [evidence directory] */
import { chromium, type Page } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const output = resolve(process.argv[2] ?? '.qa-vault-expiry')
await mkdir(output, { recursive: true })
const port = Number(process.env.WEB_PORT ?? 48131)
assert(![47291, 47292].includes(port))
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('packages/web'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
})
let serverLog = ''
server.stdout?.on('data', x => { serverLog += x })
server.stderr?.on('data', x => { serverLog += x })
const url = `http://127.0.0.1:${port}/e2e/vault-expiry.html`
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const poll = async (fn: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
  throw new Error(`Timed out: ${label}\n${serverLog}`)
}
const testApi = (p: Page, code: string) => p.evaluate(async code => {
  const api = (window as any).vaultTest
  return await new Function('api', `return (async () => { ${code} })()`)(api)
}, code)
const fixtureRow = { id: 'nay-fixture', conversationId: 'nay-fixture', title: 'Conversa com a Nay', harness: 'claude',
  model: 'claude-sonnet-5-5', cwd: '/fixture/.agentistics/nay-chat', state: 'waiting', startedAt: Date.now(),
  actionable: true, verbs: [{ action: 'prompt', enabled: true, label: 'Enviar' }], chatTurns: [], source: 'structured', engine: 'structured', terminal: false }
try {
  await poll(async () => fetch(url, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false), 'Vite startup')
  browser = await chromium.launch({ ...(process.env.QA_CHROMIUM ? { executablePath: process.env.QA_CHROMIUM } : {}), headless: true, args: ['--no-sandbox'] })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.stack) })
    let countdown: number | null = 240000
    let remote = false
    let wrong = false
    let failLock = false
    const posts: { path: string; body: any }[] = []
    const notifications: any[] = []
    await page.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname
      let status = 200, json: any = { ok: true }
      if (req.method() === 'POST') posts.push({ path, body: req.postDataJSON() })
      if (path === '/api/notifications') {
        if (req.method() === 'POST') notifications.push({ ...req.postDataJSON(), id: String(notifications.length), ts: Date.now(), read: false })
        json = notifications
      } else if (path === '/api/vault' && req.method() === 'GET') json = { state: countdown === null ? 'locked' : 'open', autoLockInMs: countdown, entries: [] }
      else if (path === '/api/vault/extend') {
        if (remote) { status = 401; json = { ok: false, code: 'stepup-required' } }
        else { countdown = 1800000; json = { ok: true, autoLockInMs: countdown } }
      } else if (path === '/api/vault/stepup') {
        if (wrong) { status = 401; json = { ok: false, code: 'stepup-wrong', sentence: 'Código incorreto. Tente novamente.' } }
        else { remote = false; json = { ok: true } }
      } else if (path === '/api/vault/lock') {
        if (failLock) { status = 503; json = { ok: false, code: 'unavailable', sentence: 'Não foi possível trancar agora.' } }
        else { countdown = null; json = { ok: true } }
      } else if (path === '/api/fleet') json = { sessions: [fixtureRow], rows: [fixtureRow], finishedTasks: [] }
      else if (path === '/api/fleet/chat') json = { ok: true, live: true, turns: [{ role: 'user', text: 'Como está o cofre?', at: Date.now() - 1000 }, { role: 'assistant', text: 'Posso avisar quando estiver perto de se trancar.', at: Date.now() }], source: 'transcript' }
      else if (path.includes('events') || path.includes('stream')) { await route.abort(); return }
      else if (path.includes('native') || path.includes('machine-fleet')) json = { sessions: [], rows: [], finishedTasks: [] }
      else if (path.includes('use-requests')) json = { ok: true, requests: [] }
      else if (path.includes('harnesses')) json = { harnesses: [] }
      else if (path.includes('tasks')) json = { tasks: [] }
      else if (path.includes('preferences')) json = {}
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })
    })
    await page.goto(url)
    const card = page.locator('[data-nay-notice="vault-expiry"]')
    await card.waitFor()
    await page.locator('[data-nay-fab]').waitFor()
    await page.waitForTimeout(300)
    assert.equal(await card.count(), 1)
    assert.equal(posts.filter(p => ['/api/vault/extend', '/api/vault/lock', '/api/vault/stepup'].includes(p.path)).length, 0, 'showing a notice must never extend or lock the vault')
    await testApi(page, 'await api.refreshVaultWatch(); await api.refreshVaultWatch()')
    await poll(async () => await testApi(page, "return api.readNotifications().filter(n => n.code === 'vault.autolock-soon').length") === 1, 'one bell entry')
    assert.equal(posts.filter(p => p.path === '/api/notifications' && p.body.code === 'vault.autolock-soon').length, 1)
    assert.equal(await testApi(page, 'return api.readNayAlerts().length'), 1)
    const background = await card.evaluate(el => getComputedStyle(el).backgroundColor)
    assert(!['rgba(0, 0, 0, 0)', 'transparent'].includes(background), `opaque background: ${background}`)
    const a = await card.boundingBox(), b = await page.locator('[data-nay-fab]').boundingBox()
    assert(a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y), 'notice must not cover Nay button')
    await page.screenshot({ path: `${output}/${width}-button.png` })
    // Existing queue/count: the single visible card includes another waiting occurrence.
    await testApi(page, "api.pushAlert({key:'other',kind:'turn',sessionId:'other',name:'Outra sessão',sinceMs:1,sinceKnown:true}); api.pushAlert({...api.readNayAlerts().find(a=>a.kind==='vault-expiry'),key:'vault-new'})")
    assert.equal(await page.locator('[data-nay-notice]').count(), 1)
    assert(await card.getByText('+1', { exact: true }).isVisible())
    await page.locator('[data-nay-fab]').click()
    await page.getByText('Conversa com a Nay', { exact: true }).first().click()
    await page.locator('[data-nay-notice-host] [data-nay-notice="vault-expiry"]').waitFor()
    await page.waitForTimeout(500)
    assert(await page.locator('textarea').first().isVisible(), 'real chat composer remains visible')
    const c = await card.boundingBox(), composer = await page.locator('textarea').first().boundingBox()
    assert(c && composer && c.y + c.height <= composer.y, 'notice must not cover chat composer')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no page overflow')
    await page.screenshot({ path: `${output}/${width}-chat.png` })
    // Keep-open succeeds only after a click.
    await card.locator('[data-vault-extend]').click()
    await card.waitFor({ state: 'detached' })
    assert.equal(posts.filter(p => p.path === '/api/vault/extend').length, 1)
    // A new window re-arms once; remote access uses CodeBoxes and preserves the error line.
    remote = true; countdown = 230000
    await testApi(page, 'await api.refreshVaultWatch()')
    await card.waitFor()
    await card.locator('[data-vault-extend]').click()
    await card.locator('input').first().waitFor()
    wrong = true
    await card.locator('input').first().pressSequentially('123456')
    await card.locator('[data-vault-extend]').click()
    await card.getByRole('status').waitFor()
    assert((await card.getByRole('status').textContent())?.includes('Código incorreto'))
    wrong = false
    await card.locator('input').first().press('Enter')
    await card.waitFor({ state: 'detached' })
    assert.equal(posts.filter(p => p.path === '/api/vault/stepup').length, 2)
    // Failure is explained; locking succeeds explicitly on retry.
    countdown = 220000; failLock = true
    await testApi(page, 'await api.refreshVaultWatch()')
    await card.waitFor()
    await card.locator('[data-vault-lock-now]').click()
    await card.getByRole('status').waitFor()
    failLock = false
    await card.locator('[data-vault-lock-now]').click()
    await card.waitFor({ state: 'detached' })
    // Dismissal does not re-show the same warning on the next poll.
    countdown = 1800000; await testApi(page, 'await api.refreshVaultWatch()')
    countdown = 210000; await testApi(page, 'await api.refreshVaultWatch()')
    await card.waitFor()
    await card.getByRole('button', { name: 'Dispensar', exact: true }).click()
    await card.waitFor({ state: 'detached' })
    await testApi(page, 'await api.refreshVaultWatch()')
    assert.equal(await card.count(), 0)
    // Step-up must also fit the floating card when the dock is closed.
    await page.getByRole('dialog', { name: 'Nay', exact: true }).getByRole('button', { name: 'Fechar', exact: true }).click()
    countdown = 1800000; await testApi(page, 'await api.refreshVaultWatch()')
    remote = true; countdown = 200000; await testApi(page, 'await api.refreshVaultWatch()')
    await card.waitFor()
    await card.locator('[data-vault-extend]').click()
    await card.locator('input').first().waitFor()
    await page.waitForTimeout(200)
    assert(await card.locator('input').last().isVisible(), 'all six code boxes fit the floating notice')
    const inputBounds = await card.locator('input').evaluateAll(inputs => inputs.map(el => {
      const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, font: parseFloat(getComputedStyle(el).fontSize) }
    }))
    const bounds = await card.boundingBox()
    assert(bounds && inputBounds.every(r => r.left >= bounds.x && r.right <= bounds.x + bounds.width), 'code boxes must not be clipped')
    if (width === 390) {
      assert(inputBounds.every(r => r.font >= 16), 'mobile inputs do not trigger Safari zoom')
      assert((await card.locator('[data-vault-extend]').boundingBox())!.height >= 44, 'mobile action target')
    }
    await page.screenshot({ path: `${output}/${width}-stepup.png` })
    wrong = false
    await card.locator('input').first().pressSequentially('123456')
    await card.locator('input').last().press('Enter')
    await card.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [], 'no React/browser errors')
    console.log(`PASS ${width}px: once/window, bell, queue/count, opaque, button/chat, extend, step-up, errors, lock, dismiss`)
    await context.close()
  }
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
