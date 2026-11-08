// QA (not part of the product): prints of the FILA.PRIORIDADE screens — the task page's Fila tab and the Live "Na fila" column —
// at 1280 and 390, in Chromium and WebKit. Run it inside ONE throwaway so it starts, seeds, shoots and stops by itself:
//
//   SHOTS_DIR=~/.agentistics/attachments/fila-prioridade agentop run --rm -- bash -c 'bun scripts/dev/fila-prioridade-shots.mjs'
//
// It boots the API (PORT) and the Vite UI (WEB_PORT) the throwaway hands it, seeds three tasks of different priority with
// queued pieces (a question open, a "não" with its reason, an "agendar" with its hour, a group, a piece the queue opened),
// shoots, then kills ONLY the two processes it started (by the pid it saved — never by name).
import { chromium, webkit } from 'playwright'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.PORT, WEB = process.env.WEB_PORT, DIR = process.env.AGENTISTICS_DIR, OUT = process.env.SHOTS_DIR
if (!PORT || !WEB || !DIR || !OUT) { console.error('needs PORT, WEB_PORT, AGENTISTICS_DIR and SHOTS_DIR (run it through `agentop run --rm`)'); process.exit(2) }
mkdirSync(OUT, { recursive: true })
const api = `http://localhost:${PORT}`, web = `http://localhost:${WEB}`
const log = (...a) => console.log('[shots]', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const logFile = n => openSync(join(OUT, `${n}.log`), 'w')

const procs = []
const spawn = (name, cmd, env) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: logFile(name), stderr: logFile(name), cwd: process.cwd() })
  procs.push({ name, p }); return p
}
const stopAll = () => { for (const { p } of procs) { try { p.kill() } catch { /* already gone */ } } }
process.on('exit', stopAll)

async function waitFor(url, what, ms = 120_000) {
  const t0 = Date.now()
  let last = "n/a"
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); last = String(r.status); if (r.ok) return } catch (e) { last = String(e).slice(0, 120) } await sleep(500) }
  console.error("[shots] last answer from", url, last)
  throw new Error(`${what} did not come up`)
}
const post = async (path, body) => {
  const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(j)}`)
  return j
}

// The API must not hold the UI's port: it gets a spare one for the second listener it may open.
spawn('api', ['bun', 'packages/server/server/index.ts'], { PORT, WEB_PORT: String(Number(WEB) + 50), AGENTISTICS_DIR: DIR })
await waitFor(`${api}/api/health`, 'the API')
spawn('ui', ['bun', 'run', '--cwd', 'packages/web', 'dev'], { PORT, WEB_PORT: WEB })
await waitFor(`${web}/`, 'the UI')
log('up')

// ---------------------------------------------------------------------------------------------------------------- seed
const now = Date.now()
const staged = (n, extra = {}) => ({ prompt: `Implementar a peça ${n}.\nLer o brief completo em docs/fila.md, respeitar a ordem de saída por prioridade, escrever os testes primeiro e abrir a sessão só quando o líder responder "sim".\nCommit a cada marco verde, sem PR, push no fim.`, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', account: 'default', cwd: process.cwd(), ...extra })
const mkTask = async (title, priority) => {
  const t = await post('/api/tasks', { title, detail: 'Fila por prioridade', priority })
  const id = t.task?.id ?? t.id
  if (!id) throw new Error(`no task id: ${JSON.stringify(t)}`)
  await post(`/api/tasks/${id}`, { priority })
  return id
}
const mkSub = async (task, title, opts = {}) => {
  const r = await post(`/api/tasks/${task}/subtasks`, { title, ...opts })
  const id = r.id ?? r.subtask?.id
  if (!id) throw new Error(`no subtask id: ${JSON.stringify(r)}`)
  return id
}
const stage = (sub, n) => post(`/api/deliveries/${sub}`, { action: 'stage', draft: staged(n), leaderSessionId: 'leader-demo' })

const tUrgent = await mkTask('Cofre: desbloqueio por biometria', 'urgent')
const tHigh = await mkTask('Motor: fila por prioridade', 'high')
const tLow = await mkTask('Site: textos da página de preços', 'low')
const a1 = await mkSub(tUrgent, 'Pergunta de desbloqueio no Mac'); await stage(a1, 'A1')
const a2 = await mkSub(tUrgent, 'Fallback por senha própria'); await stage(a2, 'A2')
const b1 = await mkSub(tHigh, 'Fluxo fila-proximo'); await stage(b1, 'B1')
const g = await mkSub(tHigh, 'Aba Fila + cartão', { isGroup: true }); await stage(g, 'G')
const m1 = await mkSub(tHigh, 'Aba Fila na página da tarefa')
const m2 = await mkSub(tHigh, 'Prioridade editável no cartão')
// A member joins its group through the board's own door (the one the Subtasks tab uses), after it exists.
for (const m of [m1, m2]) await post(`/api/tasks/${tHigh}/subtasks`, { id: m, parentGroupId: g })
const c1 = await mkSub(tLow, 'Revisar copy do plano Pro'); await stage(c1, 'C1')
const done = await mkSub(tHigh, 'Portão de vaga consertado'); await stage(done, 'D1')
await post(`/api/tasks/${tHigh}/comments`, { author: 'Motor', body: 'Brief fechado com o dono: a ordem da coluna é a ordem de saída.', subtaskId: b1 }).catch(() => undefined)
await post(`/api/tasks/${tHigh}/comments`, { author: 'Nay', body: 'O portão de vaga conta a pergunta aberta como sessão em uso.', subtaskId: b1 }).catch(() => undefined)
await post(`/api/tasks/${tHigh}/comments`, { author: 'QA', body: 'Dois ticks seguidos não abrem duas sessões.', subtaskId: b1 }).catch(() => undefined)
await post(`/api/tasks/${tHigh}/comments`, { author: 'Motor', body: 'Falta o print em 390.', subtaskId: b1 }).catch(() => undefined)
log('seeded', { tUrgent, tHigh, tLow, a1, a2, b1, g, c1 })

// The queue facts the flow would have written: an open question, a "não", an "agendar", a piece the queue opened.
const { createDeliveryStore } = await import(join(process.cwd(), 'packages/server/server/delivery/store.ts'))
const store = createDeliveryStore(join(DIR, 'deliveries.json'))
const iso = ms => new Date(ms).toISOString()
await store.update(doc => {
  const d = doc.deliveries
  const vaga = (ok, reason) => ({ ok, at: iso(now), revision: 1, ...(reason ? { reason } : {}) })
  d[a1].queueAsk = { at: iso(now - 4 * 60_000), delivered: true, leaderSessionId: 'leader-demo' }
  d[a1].gates.vaga = vaga(true)
  d[a2].queueHold = { kind: 'nao', reason: 'depende da biometria do Mac, que ainda não foi validada', at: iso(now - 30 * 60_000), actor: 'leader-demo' }
  d[a2].gates.vaga = vaga(true)
  d[b1].queueHold = { kind: 'agendar', reason: 'depois da reunião com o dono', at: iso(now - 10 * 60_000), actor: 'leader-demo', until: iso(now + 2 * 3600_000) }
  d[b1].leaderSessionId = 'leader-demo'
  d[b1].gates.vaga = vaga(false, 'no slot: 4 workers running (machine ceiling 4)')
  d[g].gates.vaga = vaga(false, 'no slot: 5 h window at 91% (≥ 85%)')
  d[c1].gates.vaga = vaga(false, 'no slot: 4 workers running (machine ceiling 4)')
  d[done].phase = 'executando'; d[done].authorSessionId = 'agentop-demo000001'
  d[done].queueStarted = { at: iso(now - 20 * 60_000), actor: 'flow:fila', auto: true, sessionId: 'agentop-demo000001' }
})
log('queue facts written')

// -------------------------------------------------------------------------------------------------------------- shoot
const shots = []
for (const [engineName, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await launcher.launch()
  for (const [label, width, height] of [['1280', 1280, 900], ['390', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { hasTouch: true, isMobile: engineName === 'chromium' } : {}), locale: 'pt-BR' })
    await ctx.addInitScript(() => { try { localStorage.setItem('lang', 'pt') } catch { /* private mode */ } })
    const page = await ctx.newPage()
    const dismiss = async () => {
      for (let k = 0; k < 4; k++) for (const n of [/Yes, preserve my history/i, /Sim, preservar/i, /Don.t show again/i, /^Not now$/i, /^Agora não$/i, /^Close$/i, /^Fechar$/i]) {
        const bt = page.getByRole('button', { name: n }).first()
        if (await bt.count()) { await bt.click({ timeout: 1500 }).catch(() => undefined); await sleep(300) }
      }
    }
    const shot = async name => { const path = join(OUT, `${engineName}-${label}-${name}.png`); await page.screenshot({ path, fullPage: false }); shots.push(path); log('shot', path) }
    const overflow = async name => log(engineName, label, name, 'scrollWidth<=innerWidth:', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))

    // A cold server can answer the first page of an engine with an error: reload (up to 3 times) until the tab is there.
    const openQueue = async task => {
      for (let tries = 0; tries < 3; tries++) {
        await page.goto(`${web}/tasks/${task}?tab=queue`, { waitUntil: 'domcontentloaded' }); await sleep(3500); await dismiss()
        if (await page.waitForSelector('[data-queue-tab]', { timeout: 15_000 }).then(() => true, () => false)) return
        log('queue tab not found, reloading', engineName, label, tries)
      }
    }
    // 1) The Fila tab of the Motor task (group, hold with its hour, notes, slot words).
    await openQueue(tHigh)
    await page.locator('[data-queue-tab]').first().scrollIntoViewIfNeeded().catch(() => undefined); await page.evaluate(() => { const t = document.querySelector('[role=tablist]'); if (t) t.scrollIntoView() }); await sleep(800); await shot('fila-motor'); await overflow('fila-motor')
    // 2) The urgent task: the open question and the "não" with its reason.
    await openQueue(tUrgent)
    await page.evaluate(() => { const t = document.querySelector('[role=tablist]'); if (t) t.scrollIntoView() }); await sleep(600); await shot('fila-cofre'); await overflow('fila-cofre')
    // 3) The schedule dialog.
    const sched = page.locator('[data-queue-action="schedule"]').first()
    if (await sched.count()) { await sched.click(); await sleep(500); await shot('fila-agendar'); await page.keyboard.press('Escape'); await sleep(300) }
    // 4) The Live board: priorities on the cards and the reason/hour under them.
    await page.goto(`${web}/tasks/live`, { waitUntil: 'domcontentloaded' }); await sleep(3500); await dismiss()
    await sleep(1200); await shot('live-na-fila'); await overflow('live-na-fila')
    await ctx.close()
  }
  await browser.close()
}
stopAll()
console.log(JSON.stringify({ shots }, null, 2))
process.exit(0)
