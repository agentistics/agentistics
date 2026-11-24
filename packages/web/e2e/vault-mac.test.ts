import { expect, test } from 'bun:test'
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const enabled = Boolean(process.env.QA_VAULT_MAC_OUTPUT)
test.skipIf(!enabled)('Mac setup failure and password fallback: desktop and 390px', async () => {
  const output = process.env.QA_VAULT_MAC_OUTPUT!
  expect(isAbsolute(output)).toBe(true)
  expect(process.env.AGENTISTICS_FLOWS).toBeUndefined()
  await mkdir(output, { recursive: true })
  const port = Number(process.env.WEB_PORT ?? 48144)
  expect([47291, 47292].includes(port)).toBe(false)
  const web = resolve(import.meta.dir, '..')
  const server = spawn('node', [resolve(web, 'node_modules/vite/bin/vite.js'), '--config', resolve(web, 'e2e/vault-mac.config.ts'), '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: web, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  })
  let logs = ''; server.stdout?.on('data', b => { logs += b }); server.stderr?.on('data', b => { logs += b })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const env = await readFile(`/proc/${server.pid}/environ`, 'utf8')
    expect(env.split('\0').some(v => v.startsWith('AGENTISTICS_FLOWS='))).toBe(false)
    let ready = false
    for (let i = 0; i < 200; i++) {
      ready = await fetch(`http://127.0.0.1:${port}/e2e/vault-mac.html`).then(r => r.ok).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 100))
    }
    expect(ready, logs).toBe(true)
    browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM, headless: true, args: ['--no-sandbox'] })
    for (const width of [1280, 390]) {
      const modes = process.env.QA_VAULT_MAC_BASELINE ? ['baseline', 'build'] : ['build']
      for (const mode of modes) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
        const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
        let begins = 0, enrolled = 'touchid'
        await page.route('**/api/**', async route => {
          const path = new URL(route.request().url()).pathname
          let result: unknown = { ok: true }
          if (path === '/api/vault') result = { state: 'open', wrappers: ['keychain'], presence: false, gates: {}, autoLockMinutes: 30 }
          if (path.endsWith('/enroll')) { enrolled = route.request().postDataJSON().protector; result = { ok: true, recoveryOwed: true, removed: [] } }
          if (path.endsWith('/begin')) { begins++; result = { ok: true, words: Array(24).fill(begins === 1 ? 'abandon' : 'ability'), positions: [1, 2, 3] } }
          if (path.endsWith('/confirm')) result = { ok: false, code: mode === 'baseline' ? 'presence-enrol-failed' : 'rekey-verify-failed', sentence: mode === 'baseline'
            ? 'Não foi possível ligar o Touch ID (ou a senha do Mac) (o cofre não pôde ser gravado). Nada foi alterado; o cofre continua como estava.'
            : 'Não foi possível conferir a nova cópia de um item do cofre. Nada foi alterado. Confira se há espaço livre e permissão para gravar nesta conta e tente de novo.' }
          await route.fulfill({ json: result })
        })
        await page.goto(`http://127.0.0.1:${port}/e2e/vault-mac.html${mode === 'baseline' ? '?baseline' : ''}`)
        await page.locator('form button[type="submit"]').click()
        await page.locator('form button[type="submit"]').click()
        await page.getByRole('button', { name: 'Já anotei', exact: true }).click()
        for (const input of await page.locator('form input').all()) await input.fill('abandon')
        await page.locator('form button[type="submit"]').click()
        await page.getByText(/Parou em:/).waitFor()
        await page.screenshot({ path: resolve(output, `${width}-${mode}-failure.png`), fullPage: true })
        if (mode === 'build') {
          const fallback = page.getByRole('button', { name: 'Continuar sem Touch ID', exact: true })
          if (width === 390) expect((await fallback.boundingBox())!.height).toBeGreaterThanOrEqual(44)
          await fallback.click()
          await page.locator('input[type="password"]').nth(1).waitFor()
          expect(await page.locator('input[type="password"]').count()).toBe(2)
          await page.screenshot({ path: resolve(output, `${width}-build-password.png`), fullPage: true })
          for (const input of await page.locator('input[type="password"]').all()) await input.fill('Test-Only!Pw9')
          await page.locator('form button[type="submit"]').click()
          await page.locator('form button[type="submit"]').waitFor()
          expect(enrolled).toBe('password'); expect(begins).toBe(1) // new words still owed
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(errors).toEqual([])
        await page.close()
      }
      if (modes.includes('baseline') || process.env.QA_VAULT_MAC_COMPARE_SAVED) {
        const page = await browser.newPage({ viewport: { width: width * 2, height: 900 } })
        const before = (await readFile(resolve(output, `${width}-baseline-failure.png`))).toString('base64')
        const after = (await readFile(resolve(output, `${width}-build-failure.png`))).toString('base64')
        await page.setContent(`<body style="margin:0;display:flex"><img width="${width}" src="data:image/png;base64,${before}"><img width="${width}" src="data:image/png;base64,${after}"></body>`)
        await page.screenshot({ path: resolve(output, `${width}-side-by-side.png`), fullPage: true }); await page.close()
      }
    }
  } finally {
    await browser?.close(); server.kill('SIGTERM')
    await new Promise<void>(r => { if (server.exitCode !== null || server.signalCode !== null) r(); else server.once('exit', () => r()) })
  }
}, 90_000)
