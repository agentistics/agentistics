/* Real-screen evidence for the glass experiment. Run through agentop run --rm only. */
import { chromium } from 'playwright'
import { mkdtemp, mkdir, cp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const out = resolve(process.env.SHOTS_DIR ?? 'leader/design/vidro-real')
// agentop run may assign isolated high ports through PORT/WEB_PORT. Never fall back to the
// owner's running server when the harness supplied them; the app and Vite must share this pair.
const apiPort = 49391
const webPort = 49392
if ([47291, 47292].includes(apiPort) || [47291, 47292].includes(webPort)) throw new Error('reserved port')
const base = `http://127.0.0.1:${webPort}`
const sourceHome = process.env.HOME
if (!sourceHome) throw new Error('HOME is required to seed the demo')
const seedHome = process.env.SEED_HOME ?? sourceHome

await mkdir(out, { recursive: true })
const demoHome = await mkdtemp(join(tmpdir(), 'agentistics-vidro-demo-'))
const seed = spawnSync('bun', ['run', 'packages/server/scripts/seed-demo.ts', '--out', demoHome, '--force'], {
  cwd: resolve('.'), env: { ...process.env, HOME: seedHome }, encoding: 'utf8', stdio: 'pipe',
})
if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`)

// seed-demo deliberately omits raw chat. Add one wholly invented Claude fixture in the
// throwaway HOME so the screenshots exercise the real transcript reader and composer without
// ever touching the owner's conversations. The metadata is still seed-demo's scrubbed row.
async function addDemoTranscript() {
  const claudeDir = join(demoHome, '.agentistics', 'sessions', 'claude')
  const files = (await readdir(claudeDir)).filter(name => name.endsWith('.json'))
  if (!files.length) throw new Error('seed produced no Claude session for transcript fixture')
  const turns = [
    ['user', 'Revise o cartão de sessões para destacar o estado atual.'],
    ['assistant', 'Vou revisar a estrutura do cartão e preservar os dados existentes.'],
    ['user', 'Comece pelo componente da lista e mantenha o layout responsivo.'],
    ['assistant', 'Encontrei a lista principal e o painel de detalhes. Vou manter os dois alinhados.'],
    ['user', 'Também precisamos de um estado vazio mais claro.'],
    ['assistant', 'Adicionei uma mensagem curta e um atalho para criar uma nova sessão.'],
    ['user', 'Verifique se o tema escuro mantém contraste suficiente.'],
    ['assistant', 'O contraste está acima do mínimo e os elementos secundários continuam legíveis.'],
    ['user', 'Agora inclua uma pequena indicação do tempo ativo.'],
    ['assistant', 'A indicação usa o mesmo formato das métricas do painel para evitar ruído visual.'],
    ['user', 'Rode os testes focados na sessão antes de concluir.'],
    ['assistant', 'Os testes focados passaram. Também conferi a versão compacta para telas estreitas.'],
    ['user', 'Faça uma última revisão da cópia em português.'],
    ['assistant', 'A cópia está em português e os rótulos permanecem consistentes entre desktop e celular.'],
    ['user', 'Perfeito, deixe a conversa pronta para revisão.'],
  ]
  for (const [fileIndex, file] of files.entries()) {
    const session = JSON.parse(await readFile(join(claudeDir, file), 'utf8'))
    if (fileIndex === 0) {
      // Keep this one demo row actionable so the standard composer is visible behind the chat menu.
      delete session.end_time
      delete session.duration_minutes
      await writeFile(join(claudeDir, file), JSON.stringify(session))
    }
    const encoded = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-')
    const transcriptDir = join(demoHome, '.claude', 'projects', encoded)
    await mkdir(transcriptDir, { recursive: true })
    const base = Date.now() - (15 + fileIndex) * 60_000
    const lines = turns.map(([role, text], i) => JSON.stringify({
      type: role,
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
      session_id: session.session_id,
      cwd: session.project_path,
      timestamp: new Date(base + i * 55_000).toISOString(),
    }))
    await writeFile(join(transcriptDir, `${session.session_id}.jsonl`), `${lines.join('\n')}\n`)
  }
  await writeFile(join(demoHome, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate', lang: 'pt', theme: 'dark' }, null, 2))
}
await addDemoTranscript()

const server = spawn(process.execPath, ['packages/server/server/index.ts'], {
  cwd: resolve('.'), env: { ...process.env, HOME: demoHome, AGENTISTICS_DIR: join(demoHome, '.agentistics'), AGENTISTICS_ARCHIVE: '0', AGENTISTICS_JOURNAL: '0', PORT: String(apiPort) }, stdio: 'pipe',
})
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  cwd: resolve('packages/web'), env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) }, stdio: 'pipe',
})
let logs = ''
server.stdout.on('data', b => { logs += b.toString() })
server.stderr.on('data', b => { logs += b.toString() })
vite.stdout.on('data', b => { logs += b.toString() })
vite.stderr.on('data', b => { logs += b.toString() })

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`servers did not start:\n${logs.slice(-3000)}`)
}
async function ready(page) {
  await page.waitForFunction(() => !/Loading your data|Carregando/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(1400)
  // Demo homes intentionally start with the first-run pricing notice. Dismiss it so every
  // capture shows the application surface being compared, not a setup gate over the surface.
  const dismiss = page.getByRole('button', { name: /Don't show again|Não mostrar novamente|Não mostrar de novo|Close/ }).first()
  if (await dismiss.count()) await dismiss.click({ force: true }).catch(() => {})
  for (const selector of ['button[aria-label="Close"]', 'button[title="Close"]', 'button[aria-label="Dismiss"]', 'button[aria-label="dismiss"]']) {
    for (const button of await page.locator(selector).all()) await button.click({ force: true }).catch(() => {})
  }
  await page.locator('button').filter({ hasText: /Não mostrar|Don.t show/ }).first().click({ force: true }).catch(() => {})
  for (const button of await page.locator('[role="alert"] button, [data-toast] button').all()) await button.click({ force: true }).catch(() => {})
  await page.waitForTimeout(250)
}
async function themeAndGlass(page, theme, glass) {
  await page.evaluate(({ theme: t, glass: g }) => {
    document.documentElement.dataset.glass = g
    document.documentElement.dataset.theme = t
  }, { theme, glass })
  await page.waitForTimeout(350)
}
async function shot(page, name, theme, glass) {
  await themeAndGlass(page, theme, glass)
  await page.screenshot({ path: join(out, `${name}-${theme}-${page.viewportSize().width}-${glass}.png`) })
}
async function openAreas(page, mobile) {
  if (mobile) {
    const more = page.locator('.mobile-bottom-nav').getByRole('button', { name: /^(More|Mais)$/ }).first()
    if (await more.count()) await more.click({ force: true })
  } else {
    const rail = page.locator('[data-area-rail]:visible').first()
    if (await rail.count()) {
      await rail.locator('button[aria-expanded="false"]').click({ force: true }).catch(() => {})
      await page.waitForFunction(() => document.querySelector('[data-area-rail]')?.getAttribute('data-open') === 'true').catch(() => {})
    }
  }
  await page.waitForTimeout(500)
}
async function openSession(page) {
  await page.goto(`${base}/sessions`, { waitUntil: 'domcontentloaded' })
  await ready(page)
      // The throwaway HOME contains an invented Claude transcript linked to the scrubbed row.
  const ended = page.getByRole('tab', { name: /Ended|Encerradas/ }).first()
  if (await ended.count()) await ended.click({ force: true }).catch(() => {})
  await page.waitForTimeout(400)
  const candidates = page.locator('[data-session-open]:visible')
  const count = Math.min(await candidates.count(), 12)
  for (let i = 0; i < count; i++) {
    await candidates.nth(i).click({ force: true }).catch(() => {})
    await page.waitForURL(/\/sessions\/[^/?]+/, { timeout: 3000 }).catch(() => {})
    if (/\/sessions\/[^/?]+/.test(new URL(page.url()).pathname)) {
      const composer = page.locator('button[aria-label="Mais opções"], button[aria-label="More options"]').first()
      if (await composer.count() && await composer.isVisible()) break
    }
    await page.goto(`${base}/sessions`, { waitUntil: 'domcontentloaded' }); await ready(page)
    const again = page.getByRole('tab', { name: /Ended|Encerradas/ }).first()
    if (await again.count()) await again.click({ force: true }).catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(1600)
  const more = page.locator('button[aria-label="Mais opções"], button[aria-label="More options"]').first()
  if (await more.count() && await more.isVisible()) await more.click({ force: true }).catch(() => {})
  await page.waitForTimeout(500)
}
async function frameMeasure(page) {
  return page.evaluate(async () => {
    const target = document.querySelector('[data-session-row], .ag-noscroll')
    const samples = []
    let previous = performance.now()
    const started = performance.now()
    while (performance.now() - started < 1200) {
      await new Promise(requestAnimationFrame)
      const now = performance.now()
      samples.push(now - previous)
      previous = now
      if (target && 'scrollTop' in target) target.scrollTop += 3
      else window.scrollBy(0, 3)
    }
    samples.sort((a, b) => a - b)
    const average = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)
    return { frames: samples.length, averageMs: Number(average.toFixed(2)), p95Ms: Number((samples[Math.floor(samples.length * .95)] ?? 0).toFixed(2)) }
  })
}

await waitFor(`http://127.0.0.1:${apiPort}/api/version`)
await waitFor(`http://127.0.0.1:${webPort}/`)
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
const metrics = []
try {
  for (const width of [1440, 390]) {
    for (const theme of ['dark', 'light']) {
      const mobile = width === 390
      const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, hasTouch: mobile })
      await context.addInitScript(({ t }) => {
        localStorage.setItem('agentistics-install-dismissed', 'true')
        localStorage.setItem('agentistics-theme', t)
        localStorage.setItem('agentistics-lang', 'pt')
      }, { t: theme })
      const page = await context.newPage()

      // (a) Sessions list with the real areas menu open.
      await page.goto(`${base}/sessions`, { waitUntil: 'domcontentloaded' }); await ready(page); await openAreas(page, mobile)
      for (const glass of ['off', 'on']) await shot(page, 'a-sessions-menu', theme, glass)
      if (mobile) {
        const client = await context.newCDPSession(page); await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        for (const glass of ['off', 'on']) { await themeAndGlass(page, theme, glass); metrics.push({ screen: 'a', theme, width, glass, ...await frameMeasure(page) }) }
      }

      // (b) A real session route with its composer/menu. Seed data has no owner transcript;
      // the empty state is retained rather than injecting fabricated conversation text.
      await openSession(page)
      for (const glass of ['off', 'on']) await shot(page, 'b-session-composer-menu', theme, glass)
      if (mobile) {
        const client = await context.newCDPSession(page); await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        for (const glass of ['off', 'on']) { await themeAndGlass(page, theme, glass); metrics.push({ screen: 'b', theme, width, glass, ...await frameMeasure(page) }) }
      }

      // (c) Agentask with its real create modal.
      await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' }); await ready(page)
      const create = page.getByRole('button', { name: /New task/ }).first(); if (await create.count()) await create.click({ force: true })
      await page.waitForTimeout(400)
      for (const glass of ['off', 'on']) await shot(page, 'c-agentask-modal', theme, glass)

      // (d) Real phone bar over the dashboard content.
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }); await ready(page)
      await page.evaluate(() => window.scrollTo(0, 500)); await page.waitForTimeout(400)
      for (const glass of ['off', 'on']) await shot(page, 'd-mobile-bottom-bar', theme, glass)
      await context.close()
    }
  }
} finally {
  await browser.close()
  server.kill('SIGTERM'); vite.kill('SIGTERM')
  await rm(demoHome, { recursive: true, force: true })
}
await writeFile(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2))
console.log(JSON.stringify({ out, metrics, seed: seed.stdout.trim().split('\n').slice(-3).join('\n') }, null, 2))
