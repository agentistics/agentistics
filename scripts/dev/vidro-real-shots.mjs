/* Real-screen evidence for the glass experiment. Run through agentop run --rm only. */
import { chromium } from 'playwright'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const out = resolve(process.env.SHOTS_DIR ?? 'leader/design/vidro-real')
// agentop run may assign isolated high ports through PORT/WEB_PORT. Never fall back to the
// owner's running server when the harness supplied them; the app and Vite must share this pair.
const apiPort = Number(process.env.API_PORT ?? 49391)
const webPort = Number(process.env.WEB_PORT ?? 49392)
if ([47291, 47292].includes(apiPort) || [47291, 47292].includes(webPort)) throw new Error('reserved port')
const base = `http://127.0.0.1:${webPort}`
const sourceHome = process.env.HOME
if (!sourceHome) throw new Error('HOME is required to seed the demo')
const seedHome = process.env.SEED_HOME ?? sourceHome

// Do not let a preview inherit path overrides that can point back at the owner's harnesses or
// archive. The seed is allowed to read only the explicitly supplied source HOME; the app gets a
// separate allowlist plus a private tmux socket below.
const pathEnv = process.env.PATH ?? '/usr/bin:/bin'
const seedEnv = { PATH: pathEnv, HOME: seedHome, USERPROFILE: seedHome, ...(process.env.VOLTA_HOME ? { VOLTA_HOME: process.env.VOLTA_HOME } : {}) }

await mkdir(out, { recursive: true })
const demoHome = await mkdtemp(join(tmpdir(), 'agentistics-vidro-demo-'))
const seed = spawnSync('bun', ['run', 'packages/server/scripts/seed-demo.ts', '--out', demoHome, '--force'], {
  cwd: resolve('.'), env: seedEnv, encoding: 'utf8', stdio: 'pipe',
})
if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`)

// seed-demo deliberately omits raw chat. Write invented chat only after the server returns a real
// Claude Fleet row, using that row's exact conversation id and cwd. Never infer a route from a seed
// filename, and never read a transcript from the source HOME.
const demoDataDir = resolve(join(demoHome, '.agentistics'))
const appEnv = {
  PATH: pathEnv, HOME: demoHome, USERPROFILE: demoHome,
  AGENTISTICS_DIR: demoDataDir, AGENTISTICS_ARCHIVE_DIR: join(demoDataDir, 'archive'),
  AGENTISTICS_JOURNAL_DIR: join(demoDataDir, 'journal'), AGENTISTICS_JOURNAL: '0',
  CLAUDE_DIR: join(demoHome, '.claude'), CODEX_DIR: join(demoHome, '.codex'),
  GEMINI_DIR: join(demoHome, '.gemini'), COPILOT_DIR: join(demoHome, '.copilot'),
  AGENTISTICS_HARNESS_CODEX: '0', AGENTISTICS_HARNESS_GEMINI: '0', AGENTISTICS_HARNESS_COPILOT: '0',
  AGENTISTICS_HARNESS_KIMI: '0', AGENTISTICS_HARNESS_ANTIGRAVITY: '0',
  AGENTISTICS_TEAM_CENTRAL: '0', AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_EXPERIMENTAL: '0',
  TMPDIR: join(demoHome, 'tmp'),
  PORT: String(apiPort), WEB_PORT: String(webPort), SERVE_STATIC: '1',
  ...(process.env.VOLTA_HOME ? { VOLTA_HOME: process.env.VOLTA_HOME } : {}),
}
await mkdir(join(demoHome, 'tmp'), { recursive: true })

const server = spawn('bun', ['packages/server/server/index.ts'], {
  cwd: resolve('.'), env: { ...appEnv, WEB_PORT: String(apiPort + 1) }, stdio: 'pipe',
})
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  cwd: resolve('packages/web'), env: appEnv, stdio: 'pipe',
})
let logs = ''
server.stdout.on('data', b => { logs += b.toString() })
server.stderr.on('data', b => { logs += b.toString() })
vite.stdout.on('data', b => { logs += b.toString() })
vite.stderr.on('data', b => { logs += b.toString() })

async function waitFor(url) {
  const started = Date.now()
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) { console.log(`[bootstrap] ready ${url} status=${response.status} after=${Date.now() - started}ms`); return }
      if (i % 10 === 0) console.log(`[bootstrap] waiting ${url} status=${response.status}`)
    } catch (error) {
      if (i % 10 === 0) console.log(`[bootstrap] waiting ${url} error=${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`bootstrap timeout after 60000ms url=${url} api=${apiPort} web=${webPort}\n${logs.slice(-3000)}`)
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
    await page.getByRole('button', { name: /^(Ended|Encerradas)$/ }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(500)
    const rail = page.locator('[data-area-rail]').first()
    if (await rail.count()) await rail.hover({ force: true })
  }
  await page.waitForTimeout(600)
}
async function openSession(page, theme) {
  await page.goto(`${base}/preview/chat-activity/?theme=${theme}`, { waitUntil: 'networkidle' })
  await page.locator('[data-activity-icon]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
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
      await openSession(page, theme)
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
