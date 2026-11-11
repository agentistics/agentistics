import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const output = resolve(process.argv[2] ?? '.superpowers/qa/vault-bulk')
await mkdir(output, { recursive: true })
const port = Number(process.env.WEB_PORT ?? 48144)
assert(![47291, 47292].includes(port))
const server = spawn('node', [resolve('packages/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('packages/web'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
})
let logs = ''
server.stdout?.on('data', b => { logs += b })
server.stderr?.on('data', b => { logs += b })
server.on('error', e => { logs += String(e) })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const url = `http://127.0.0.1:${port}/e2e/vault-bulk.html`
  let ready = false
  for (let n = 0; n < 300; n++) {
    ready = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert(ready, logs)
  browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM, headless: true, args: ['--no-sandbox'] })
  for (const width of [1280, 390]) for (const partial of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${url}${partial ? '?partial' : ''}`)
    await page.locator('[data-vault-select]').click()
    assert.equal(await page.getByRole('checkbox').count(), 5, 'system secret is not selectable')
    // Select the entire set, then narrow the filter. Hidden selections must never move.
    await page.getByRole('checkbox').first().click()
    await page.getByRole('textbox', { name: 'Buscar por nome, grupo, tag ou anotação…', exact: true }).fill('Demo')
    await page.waitForFunction(() => document.querySelector('[data-vault-batch-move]')?.textContent?.includes('3'))
    await page.screenshot({ path: resolve(output, `${width}-${partial ? 'partial' : 'success'}-selection.png`), fullPage: true })
    const move = page.locator('[data-vault-batch-move]')
    if (width === 390) {
      const box = await move.boundingBox()
      assert(box && box.height >= 44)
    }
    await move.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Sem grupo', exact: true }).click()
    // Existing group for partial; create a group for success.
    if (partial) await page.getByRole('option', { name: 'Equipe', exact: true }).click()
    else {
      await page.getByRole('listbox').getByRole('textbox').fill('Novo grupo')
      await page.getByRole('option', { name: /Criar grupo/ }).click()
      await dialog.getByRole('button', { name: 'Novo grupo', exact: true }).waitFor()
    }
    await page.screenshot({ path: resolve(output, `${width}-${partial ? 'partial' : 'success'}-dialog.png`), fullPage: true })
    await dialog.getByRole('button', { name: 'Mover 3 segredos', exact: true }).click()
    await page.locator('[data-vault-move-result]').waitFor()
    const result = await page.locator('[data-vault-move-result]').innerText()
    assert(result.includes(partial ? '2 movidos, 1 falharam' : '3 movidos.'), result)
    if (partial) assert(result.includes('Demo Beta (Atualizado em outra janela)'))
    const groups = JSON.parse(await page.locator('[data-fixture-groups]').textContent() ?? '[]')
    assert.equal(groups[3].groupId, null, 'hidden entry is never moved')
    assert.equal(groups.filter((g: { groupId: string | null }) => g.groupId !== null).length, partial ? 2 : 3)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
    await page.screenshot({ path: resolve(output, `${width}-${partial ? 'partial' : 'success'}-result.png`), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, partial, result, groups, overflow: false }))
    await page.close()
  }
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise<void>(r => { if (server.exitCode !== null || server.signalCode !== null) r(); else server.once('exit', () => r()) })
}
