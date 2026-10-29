import { randomUUID } from 'node:crypto'
/* Real-screen evidence for the glass experiment. Run through agentop run --rm only. */
import { chromium } from 'playwright'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
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
const expectedChatText = 'Revise o cartão de sessões para destacar o estado atual.'
const demoCwd = join(demoHome, 'demo-workspace')
const demoManagedId = `glass-${randomUUID().replaceAll('-', '').slice(0, 20)}`
const demoConversationId = randomUUID()
function fnv8(value) {
  let hash = 0x811c9dc5
  for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0 }
  return hash.toString(16).padStart(8, '0')
}
const demoTmuxSocket = `agentop-${fnv8(demoDataDir)}`
const demoTmuxName = `agentop-${demoManagedId}`
const appEnv = {
  PATH: pathEnv, HOME: demoHome, USERPROFILE: demoHome,
  AGENTISTICS_DIR: demoDataDir, AGENTISTICS_ARCHIVE_DIR: join(demoDataDir, 'archive'),
  AGENTISTICS_JOURNAL_DIR: join(demoDataDir, 'journal'), AGENTISTICS_JOURNAL: '0',
  CLAUDE_DIR: join(demoHome, '.claude'), CODEX_DIR: join(demoHome, '.codex'),
  GEMINI_DIR: join(demoHome, '.gemini'), COPILOT_DIR: join(demoHome, '.copilot'),
  AGENTISTICS_HARNESS_CODEX: '0', AGENTISTICS_HARNESS_GEMINI: '0', AGENTISTICS_HARNESS_COPILOT: '0',
  AGENTISTICS_HARNESS_KIMI: '0', AGENTISTICS_HARNESS_ANTIGRAVITY: '0',
  AGENTISTICS_TEAM_CENTRAL: '0', AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_EXPERIMENTAL: '0',
  TMUX_TMPDIR: join(demoHome, 'tmux'), TMPDIR: join(demoHome, 'tmp'),
  PORT: String(apiPort), WEB_PORT: String(webPort), SERVE_STATIC: '1',
  ...(process.env.VOLTA_HOME ? { VOLTA_HOME: process.env.VOLTA_HOME } : {}),
}
await mkdir(demoCwd, { recursive: true })
await mkdir(join(demoHome, 'tmux'), { recursive: true })
await writeFile(join(demoDataDir, 'managed-sessions.json'), JSON.stringify([{
  id: demoManagedId, harness: 'claude', cwd: demoCwd, createdAt: new Date().toISOString(),
  conversationId: demoConversationId, conversationLink: 'assigned', conversationLinkVia: 'assigned-id',
  label: 'Demonstração Vidro Real', mode: 'no-questions',
}], null, 2))
// A process named `claude` (a symlink to sleep): live-session detection matches on the process name, so the
// row is a running harness session that accepts prompts, and the composer menu opens by a real click.
await mkdir(join(demoHome, 'bin'), { recursive: true })
const fakeClaude = join(demoHome, 'bin', 'claude')
await symlink(spawnSync('which', ['sleep'], { encoding: 'utf8' }).stdout.trim() || '/bin/sleep', fakeClaude)
const tmuxSeed = spawnSync('tmux', ['-L', demoTmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', demoTmuxName, '-c', demoCwd, '-e', `AGENTOP_MANAGED_ID=${demoManagedId}`, '--', fakeClaude, '600'], { env: appEnv, encoding: 'utf8', stdio: 'pipe' })
if (tmuxSeed.status !== 0) throw new Error(`[fixture] isolated tmux backend failed: ${tmuxSeed.stderr || tmuxSeed.stdout}`)
function stopDemoTmux() {
  spawnSync('tmux', ['-L', demoTmuxSocket, 'kill-server'], { env: appEnv, stdio: 'ignore' })
}
const inventedTurns = [
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
async function addDemoTranscript(row) {
  const sessionId = row.conversationId ?? row.id
  if (!sessionId || !row.cwd || row.harness !== 'claude') throw new Error('[fixture] selected row lacks Claude id/cwd')
  const encoded = row.cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const transcriptDir = join(demoHome, '.claude', 'projects', encoded)
  await mkdir(transcriptDir, { recursive: true })
  const base = Date.now() - 15 * 60_000
  const lines = inventedTurns.map(([role, text], i) => JSON.stringify({
      type: role,
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
      session_id: sessionId,
      cwd: row.cwd,
      timestamp: new Date(base + i * 55_000).toISOString(),
    }))
  await writeFile(join(transcriptDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
  await writeFile(join(demoHome, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate', lang: 'pt', theme: 'dark' }, null, 2))
}


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
const rects = {}
async function shot(page, name, theme, glass, selector) {
  await themeAndGlass(page, theme, glass)
  if (selector) {
    const r = await page.evaluate(sel => { const els = [...document.querySelectorAll(sel)].filter(e => e.getBoundingClientRect().width > 0); if (!els.length) return null; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0; for (const e of els) { const b = e.getBoundingClientRect(); x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom) } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }, selector)
    if (r) rects[`${name}-${theme}-${page.viewportSize().width}`] = r
    else console.log(`[rect] no element for ${selector} in ${name} ${theme} ${page.viewportSize().width}`)
  }
  await page.screenshot({ path: join(out, `${name}-${theme}-${page.viewportSize().width}-${glass}.png`) })
}
async function showEnded(page) {
  await page.getByText(/^(Ended|Encerradas)$/).first().click({ force: true }).catch(() => console.log('[ended] tab not found'))
  await page.waitForTimeout(700)
}
async function openAreas(page, mobile) {
  if (mobile) {
    await showEnded(page)
    const more = page.locator('.mobile-bottom-nav').getByRole('button', { name: /^(More|Mais)$/ }).first()
    if (await more.count()) await more.click({ force: true })
  } else {
    await showEnded(page)
    const rail = page.locator('[data-area-rail]').first()
    if (await rail.count()) await rail.hover({ force: true })
  }
  await page.waitForTimeout(600)
}
async function openSession(page, theme) {
  if (liveOk && preparedSession) {
    await page.goto(`${base}/sessions/${encodeURIComponent(preparedSession.routeId)}`, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await page.waitForSelector('textarea', { state: 'attached', timeout: 30_000 })
    await page.waitForFunction(text => document.body.innerText.includes(text), expectedChatText, { timeout: 30_000 })
    await page.waitForTimeout(600)
    const more = page.locator('button[aria-label="Mais opções"], button[aria-label="More options"], button[aria-haspopup="menu"]').last()
    if (await more.count()) await more.click().catch(error => console.log('[b] real click on the composer menu failed:', String(error).slice(0, 160)))
    await page.waitForTimeout(600)
    if (!(await page.locator('[data-composer-menu]').count())) console.log('[b] composer menu did not open')
    return 'live'
  }
  await page.goto(`${base}/preview/chat-activity/?theme=${theme}`, { waitUntil: 'networkidle' })
  await page.locator('[data-activity-icon]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  return 'preview'
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
let liveOk = false
let preparedSession = null
try {
const probeResponse = await fetch(`http://127.0.0.1:${apiPort}/api/fleet`)
const probeText = await probeResponse.text()
let probe = {}
try { probe = JSON.parse(probeText) } catch {}
const probeRows = Array.isArray(probe.rows) ? probe.rows : (Array.isArray(probe.sessions) ? probe.sessions : [])
const closedResponse = await fetch(`http://127.0.0.1:${apiPort}/api/fleet/closed`)
const closedText = await closedResponse.text()
let closed = {}
try { closed = JSON.parse(closedText) } catch {}
const closedRows = Array.isArray(closed.rows) ? closed.rows : (Array.isArray(closed.sessions) ? closed.sessions : [])
// A closed row cannot prove a composer exists. Essential a/b evidence therefore requires an
// active Claude row returned by Fleet with all three facts needed by the real chat reader.
const fixtureRow = probeRows.find(row => row.id === demoManagedId
  && row.conversationId === demoConversationId && row.harness === 'claude' && row.cwd === demoCwd)
const probeId = fixtureRow?.id ?? null
preparedSession = null
if (fixtureRow) {
  await addDemoTranscript(fixtureRow)
  preparedSession = { routeId: fixtureRow.id, conversationId: fixtureRow.conversationId, cwd: fixtureRow.cwd }
}
console.log(JSON.stringify({
  probe: 'fleet', status: probeResponse.status, keys: Object.keys(probe), rowCount: probeRows.length, closedStatus: closedResponse.status, closedKeys: Object.keys(closed), closedRowCount: closedRows.length,
  matched: Boolean(fixtureRow), rowShape: fixtureRow ? Object.keys(fixtureRow).sort() : null,
  provenance: fixtureRow ? 'isolated-demo-registry+tmux' : 'unproven',
  row: fixtureRow ? { id: 'demo-managed', conversationId: 'demo-conversation', harness: 'claude', cwd: 'demo-workspace' } : null,
}, null, 2))
if (probeId) {
  const chatProbe = await fetch(`http://127.0.0.1:${apiPort}/api/fleet/chat?id=${encodeURIComponent(probeId)}&lang=pt`)
  const chatText = await chatProbe.text()
  let chat = {}
  try { chat = JSON.parse(chatText) } catch {}
  const hasExpectedText = chatText.includes(expectedChatText)
  console.log(JSON.stringify({ probe: 'chat', status: chatProbe.status, keys: Object.keys(chat), turnCount: Array.isArray(chat.turns) ? chat.turns.length : null, live: chat.live, unavailable: chat.unavailable, hasExpectedText }, null, 2))
  if (chatProbe.status !== 200 || !Array.isArray(chat.turns) || chat.turns.length < 2 || !hasExpectedText) {
    throw new Error(`[fixture] preflight failed: chat=200, turns>=2 and invented text required; status=${chatProbe.status} turns=${Array.isArray(chat.turns) ? chat.turns.length : 'invalid'} expected=${hasExpectedText}`)
  }
} else {
  throw new Error('[fixture] preflight failed: matched=false; no active Claude row with id, conversationId and cwd')
}
liveOk = true
} catch (error) { console.log('[b] live fixture failed, falling back to preview:', String(error).slice(0, 300)) }
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
const metrics = []
const only = process.env.SCREENS ? new Set(process.env.SCREENS.split(',')) : null
const want = k => !only || only.has(k)
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

if (want('a')) {
      // (a) Sessions list with the real areas menu open.
      await page.goto(`${base}/sessions`, { waitUntil: 'domcontentloaded' }); await ready(page); await openAreas(page, mobile)
      for (const glass of ['off', 'on']) await shot(page, 'a-sessions-menu', theme, glass, '[data-area-rail][data-open=\"true\"], div[role=\"dialog\"][aria-modal=\"true\"] > div')
      if (mobile) {
        const client = await context.newCDPSession(page); await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        for (let round = 1; round <= 3; round++) for (const glass of ['off', 'on']) { await themeAndGlass(page, theme, glass); metrics.push({ screen: 'a', theme, width, glass, round, ...await frameMeasure(page) }) }
      }

}

      if (want('b')) {
      // (b) A real session route with its composer/menu. Seed data has no owner transcript;
      // the empty state is retained rather than injecting fabricated conversation text.
      await openSession(page, theme)
      for (const glass of ['off', 'on']) await shot(page, 'b-session-composer-menu', theme, glass, '[data-composer-menu]')
      if (mobile) {
        const client = await context.newCDPSession(page); await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        for (let round = 1; round <= 3; round++) for (const glass of ['off', 'on']) { await themeAndGlass(page, theme, glass); metrics.push({ screen: 'b', theme, width, glass, round, ...await frameMeasure(page) }) }
      }

}

      if (want('c')) {
      // (c) Agentask with its real create modal.
      await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' }); await ready(page)
      const create = page.getByRole('button', { name: /New task/ }).first(); if (await create.count()) await create.click({ force: true })
      await page.waitForTimeout(400)
      for (const glass of ['off', 'on']) await shot(page, 'c-agentask-modal', theme, glass, 'body > div[style*=\"z-index: 999\"] > div')

}

      if (want('d')) {
      // (d) Real phone bar over the dashboard content.
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }); await ready(page)
      await page.evaluate(() => window.scrollTo(0, 500)); await page.waitForTimeout(400)
      for (const glass of ['off', 'on']) await shot(page, 'd-mobile-bottom-bar', theme, glass, '.mobile-bottom-nav')
}

            // (e) Plan-usage popover (opens on hover/focus of the gauge button in the sessions aside).
      if (want('e')) {
        await page.goto(`${base}/sessions`, { waitUntil: 'domcontentloaded' }); await ready(page)
        await showEnded(page); await page.waitForFunction(() => document.querySelectorAll('[data-session-row]').length >= 5, undefined, { timeout: 60_000 }).catch(() => console.log('[e] fewer than 5 rows')); await page.waitForTimeout(1000)
        const gauge = page.locator('button[aria-haspopup="dialog"]:visible').first()
        if (await gauge.count()) { if (mobile) await gauge.focus(); else await gauge.hover({ force: true }); await page.locator('[data-plan-usage-popover]').first().waitFor({ timeout: 5000 }).catch(() => {}) }
        else console.log(`[e] gauge button not visible at ${width}px`)
        await page.waitForTimeout(500)
        for (const glass of ['off', 'on']) await shot(page, 'e-plan-usage-popover', theme, glass, '[data-plan-usage-popover]')
      }

      // (f) Nay notification card, raised by the real "Test a notification" button in Settings.
      if (want('f')) {
        await page.goto(`${base}/settings/notifications`, { waitUntil: 'domcontentloaded' }); await ready(page)
        const test = page.getByRole('button', { name: /Test a notification|Testar uma notificação/ }).first()
        if (await test.count()) { await test.click({ force: true }); await page.locator('[data-nay-notice]').first().waitFor({ timeout: 8000 }).catch(() => console.log(`[f] card did not appear at ${width}px`)) }
        else console.log(`[f] test button not found at ${width}px`)
        // Client-side navigation keeps the card (it lives in the global dock) and puts it over real content.
        await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')) })
        await page.waitForTimeout(1500)
        for (const glass of ['off', 'on']) await shot(page, 'f-nay-notice', theme, glass, '[data-nay-notice]')
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  server.kill('SIGTERM'); vite.kill('SIGTERM')
  stopDemoTmux()
  await rm(demoHome, { recursive: true, force: true })
}
let prevRects = {}
try { prevRects = JSON.parse(await readFile(join(out, 'rects.json'), 'utf8')) } catch {}
await writeFile(join(out, 'rects.json'), JSON.stringify({ ...prevRects, ...rects }, null, 2))
await writeFile(join(out, only ? 'metrics-extra.json' : 'metrics.json'), JSON.stringify(metrics, null, 2))
console.log(JSON.stringify({ out, metrics, seed: seed.stdout.trim().split('\n').slice(-3).join('\n') }, null, 2))
