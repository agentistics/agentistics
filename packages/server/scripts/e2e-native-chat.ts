#!/usr/bin/env bun
/**
 * e2e-native-chat — UI.2/UI.3 end to end, in a real browser (Playwright/Chromium), against a
 * THROWAWAY preview: an isolated data dir, the web, the host and an engine whose MODEL is a scripted
 * streaming stub (the engine repo's `engine/e2e/native-ui` slot — the real hub, loop, tools, policy,
 * SSE, approvals and cancel; only the model is replaced, a real one needs the owner's key).
 *
 *   PREVIEW_URL=http://127.0.0.1:48392 WORKSPACE=/abs/git/dir OUT_DIR=/abs/dir \
 *     bun packages/server/scripts/e2e-native-chat.ts [--lang en|pt] [--width 390]
 *
 * The run: open the wizard from "+ New session" → pick Agentistics → provider + model → the folder →
 * a task's SUBTASK to file it under → a first message → start → the answer streams in → the shell
 * call asks → approve → its card turns done and the file exists → a long answer → Stop ends it
 * mid-stream → the header names the task, and the task's own page carries the session and its cost
 * (UI follow-up 2). A screenshot at every step; any failed expectation exits non-zero.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d }
const BASE = process.env.PREVIEW_URL ?? 'http://127.0.0.1:48392'
const WS = process.env.WORKSPACE ?? ''
const OUT = process.env.OUT_DIR ?? join(process.cwd(), 'e2e-native-chat-out')
const LANG = arg('--lang', 'en') as 'en' | 'pt'
const WIDTH = Number(arg('--width', '390'))
const pt = LANG === 'pt'
const T = (en: string, ptText: string) => (pt ? ptText : en)
if (!WS || !existsSync(WS)) { console.error('WORKSPACE must be an existing absolute directory'); process.exit(2) }
mkdirSync(OUT, { recursive: true })

let step = 0
async function shot(page: Page, name: string) {
  step += 1
  const file = join(OUT, `${LANG}-${WIDTH}-${String(step).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  📸 ${file}`)
}
function expectThat(ok: boolean, what: string) {
  if (!ok) throw new Error(`expected: ${what}`)
  console.log(`  ✓ ${what}`)
}
async function noHorizontalScroll(page: Page, where: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expectThat(over <= 1, `no horizontal page scroll (${where}, overflow ${over}px)`)
}

async function dismissFirstRun(page: Page) {
  // First-run prompts of a fresh data dir (history archive, billing, install the app).
  for (let i = 0; i < 8; i++) {
    const b = page.getByRole('button', { name: /No, use each tool|Não, us|Don.t show again|Não mostrar|Not now|Agora não/ }).first()
    if (!(await b.isVisible().catch(() => false))) { await page.waitForTimeout(400); continue }
    await b.click()
    await page.waitForTimeout(500)
  }
}

await fetch(`${BASE}/api/user-prefs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: LANG }) })
// The delivery the session is filed under — a task with one subtask, made through the board's API.
const TASK_TITLE = `${T('Native delivery', 'Entrega nativa')} ${WIDTH}-${Date.now() % 100000}`
const SUBTASK_TITLE = T('Write hello.txt', 'Escrever hello.txt')
const madeTask = await (await fetch(`${BASE}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: TASK_TITLE }) })).json() as { task?: { id: string }; id?: string }
const TASK_ID = madeTask.task?.id ?? madeTask.id ?? ''
await fetch(`${BASE}/api/tasks/${encodeURIComponent(TASK_ID)}/subtasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: SUBTASK_TITLE }) })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } })
const errors: string[] = []
page.on('pageerror', e => errors.push(String(e)))

try {
  console.log(`▶ native chat e2e — ${LANG}, ${WIDTH}px`)
  await page.goto(`${BASE}/sessions`)
  await page.waitForTimeout(2500)
  await dismissFirstRun(page)

  // 1. the wizard, from "+ New session"
  await page.getByRole('button', { name: T('New session', 'Nova sessão') }).first().click()
  const dlg = page.getByRole('dialog').filter({ hasText: T('New session', 'Nova sessão') }).last()
  const native = dlg.locator('button', { hasText: 'Agentistics' }).first()
  await native.waitFor({ timeout: 15000 })
  await shot(page, 'wizard-harness-list')
  expectThat(true, 'the native harness is offered (the engine provides the runtime)')
  await native.click()

  // provider (first configured one is pre-selected) and a typed model
  await dlg.getByText('Ollama').first().waitFor()
  expectThat(true, 'a configured provider is pre-selected (Ollama: local, keyless)')
  await dlg.getByRole('button', { name: T('Choose a model', 'Escolha um modelo') }).click()
  await dlg.getByRole('textbox', { name: T('Model id', 'Id de modelo') }).fill('stub-model')
  await dlg.getByRole('textbox', { name: T('Model id', 'Id de modelo') }).press('Enter')
  await dlg.getByRole('textbox', { name: T('Title', 'Título') }).fill(T('Native e2e', 'E2E nativo'))
  await shot(page, 'wizard-assistant-step')
  await noHorizontalScroll(page, 'wizard')
  await page.getByRole('button', { name: T('Continue', 'Continuar'), exact: false }).last().click()

  // 2. where: a typed absolute path is offered as a row
  await page.getByPlaceholder(T('Search repository, project or folder…', 'Buscar repositório, projeto ou pasta…')).fill(WS)
  await page.getByText(WS.split('/').pop()!, { exact: false }).last().waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
  await page.locator('[role="option"], button').filter({ hasText: WS.split('/').pop()! }).last().click()
  // the task step, as for a fleet session: pick the delivery, then its subtask
  await page.getByRole('button', { name: T('None — pick or create…', 'Nenhuma — escolher ou criar…') }).click()
  await page.getByPlaceholder(T('Search tasks, or type a new name', 'Buscar tarefas, ou digitar um nome novo')).fill(TASK_TITLE)
  await page.getByRole('button', { name: new RegExp(TASK_TITLE) }).first().click()
  await page.getByRole('button', { name: SUBTASK_TITLE }).first().click()
  await page.getByRole('button', { name: new RegExp(TASK_TITLE) }).first().waitFor()
  expectThat(true, 'the task step is offered for a native session, and a subtask is picked')
  await shot(page, 'wizard-where-step')
  await page.getByRole('button', { name: T('Continue', 'Continuar'), exact: false }).last().click()

  // 3. the first message
  await page.locator('textarea').first().fill(T('Create hello.txt saying hello.', 'Crie hello.txt dizendo hello.'))
  await page.getByRole('button', { name: T('Continue', 'Continuar'), exact: false }).last().click()
  await shot(page, 'wizard-review')
  await page.getByRole('button', { name: T('Start session', 'Iniciar sessão') }).click()

  // 4. the native chat: the answer streams in
  await page.waitForURL(/\/sessions\/ses_[0-9a-f]{32}$/, { timeout: 15000 })
  expectThat(true, `routed to the native session (${page.url().split('/').pop()})`)
  await page.getByTestId('native-session').waitFor()
  await page.getByText(/I will create/).first().waitFor({ timeout: 15000 })
  await shot(page, 'first-answer')

  // 5. the shell call asks; approve it
  const approval = page.getByTestId('native-approval').first()
  await approval.waitFor({ timeout: 20000 })
  expectThat((await approval.innerText()).includes('echo hello > hello.txt'), 'the approval shows the exact command')
  expectThat(await page.locator('[data-testid="tool-card"][data-status="awaiting"]').count() === 1, 'its tool card awaits approval')
  await page.waitForTimeout(800) // let any late window read land: a duplicate would show now
  expectThat(await page.getByText(/with a shell command/).count() === 1, 'the answer is shown once (no streamed duplicate)')
  expectThat((await page.getByTestId('native-state').innerText()).includes(T('working', 'trabalhando')), 'the session reads as working while it waits for the person')
  expectThat(await page.getByTestId('native-session').getByRole('button', { name: T('Stop', 'Parar') }).count() === 1, 'Stop is offered while the run is in flight')
  await shot(page, 'approval')
  await noHorizontalScroll(page, 'approval')
  await approval.getByRole('button', { name: T('Allow once', 'Permitir uma vez') }).click()

  // 6. the card turns done, the file exists, the answer ends
  await page.getByText(/hello\.txt now says hello/).first().waitFor({ timeout: 20000 })
  await page.locator('[data-testid="tool-card"][data-status="completed"]').first().waitFor({ timeout: 10000 })
  expectThat(readFileSync(join(WS, 'hello.txt'), 'utf8').trim() === 'hello', 'the approved command really ran (hello.txt = hello)')
  await page.getByTestId('native-state').filter({ hasText: T('ready', 'pronta') }).waitFor({ timeout: 10000 })
  expectThat(await page.getByText(/with a shell command/).count() === 1, 'still once after the run')
  await shot(page, 'tool-done')

  // 7. a long answer, stopped mid-stream
  const chat = page.getByTestId('native-session')
  await chat.locator('textarea').fill(T('Now write a long answer.', 'Agora escreva uma resposta long.'))
  await chat.getByRole('button', { name: T('Send', 'Enviar') }).click()
  await page.getByText(/word5\b/).first().waitFor({ timeout: 15000 })
  const live = page.getByText(/word5\b/).first()
  const before = (await live.innerText()).length
  await page.waitForTimeout(500)
  const after = (await live.innerText()).length
  expectThat(after > before, `the answer streams in while the model writes (${before} → ${after} chars in 0.5 s)`)
  await shot(page, 'long-streaming')
  await chat.getByRole('button', { name: T('Stop', 'Parar') }).click()
  await page.getByTestId('native-state').filter({ hasText: T('ready', 'pronta') }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(1500)
  const html = await page.content()
  expectThat(!html.includes('word400'), 'Stop ended the answer before its end (no word400)')
  expectThat(await page.getByTestId('stopped-answer').count() === 1, 'what was written stays, marked as stopped')
  await shot(page, 'stopped')
  await noHorizontalScroll(page, 'after stop')

  // 7b. filed: the header names the task; the board carries the session and its cost
  await page.getByTestId('native-filing').filter({ hasText: TASK_TITLE }).waitFor({ timeout: 15000 })
  expectThat(true, 'the session header names the task it is filed under')
  const sessionId = page.url().split('/').pop()!
  const detail = await (await fetch(`${BASE}/api/tasks/${encodeURIComponent(TASK_ID)}`)).json() as {
    task: { rollup: { costUSD: number | null; sessionsUsed: number; rounds: number | null }; sessions: { id: string; native?: boolean; subtaskId: string | null; costUSD: number | null }[]; subtaskRollups: { id: string | null; rollup: { costUSD: number | null } }[] }
  }
  const filed = detail.task.sessions.find(x => x.id === sessionId)
  expectThat(filed?.native === true && filed.subtaskId !== null, 'the task lists the native session under its subtask')
  expectThat((detail.task.rollup.costUSD ?? 0) > 0 && (filed?.costUSD ?? 0) > 0, `its cost rolls up into the task ($${detail.task.rollup.costUSD})`)
  expectThat(detail.task.rollup.rounds === 2, `both messages count as rounds, the stopped one too (${detail.task.rollup.rounds})`)
  expectThat(detail.task.subtaskRollups.some(v => v.id === filed?.subtaskId && (v.rollup.costUSD ?? 0) > 0), 'and into the subtask')
  await page.goto(`${BASE}/tasks/${encodeURIComponent(TASK_ID)}`)
  await page.waitForTimeout(2000)
  await dismissFirstRun(page)
  await shot(page, 'task-page')
  await page.goto(`${BASE}/sessions/${sessionId}`)
  await page.getByTestId('native-session').waitFor()

  // 8. leave, find it in the sessions list, reopen it: the conversation comes back from the window
  const url = page.url()
  await page.goto(`${BASE}/sessions`)
  await page.waitForTimeout(1500)
  await dismissFirstRun(page)
  expectThat(await page.getByText(/did not appear|não apareceu/).count() === 0, 'no "failed to start" placeholder for the native session')
  const row = page.getByTestId('native-sessions').getByRole('button', { name: T('Native e2e', 'E2E nativo') }).first()
  await row.waitFor({ timeout: 20000 })
  await shot(page, 'sessions-list')
  await row.click()
  await page.waitForURL(url, { timeout: 10000 })
  await page.getByText(/hello\.txt now says hello/).first().waitFor({ timeout: 15000 })
  expectThat(true, 'reopened from the list, with its history')
  await shot(page, 'reopened')

  expectThat(errors.length === 0, `no page errors (${errors.join(' | ').slice(0, 300)})`)
  console.log('✔ passed')
} catch (e) {
  await shot(page, 'FAILED').catch(() => {})
  console.error(`✘ ${e instanceof Error ? e.message : String(e)}`)
  if (errors.length) console.error('page errors:', errors.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
}
