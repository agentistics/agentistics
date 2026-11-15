/**
 * NAVEGADOR S2 — the verbs and the block rules against a REAL headless Chromium. Opt-in
 * (`BROWSER_INTEGRATION=1`), one browser, stopped at the end. Run inside a throwaway:
 *
 *   agentop run --rm -- env BROWSER_INTEGRATION=1 AGENTISTICS_BROWSER_BIN=<headless shell> \
 *     bun test packages/server/server/browser/browser-s2.integration.test.ts
 *
 * Local servers stand in for everything: an APP (the person's dev server — must be allowed), two
 * "agentistics ports" and a "neighbour debug port" (each a live listener answering SECRET — must never
 * be reached), a redirect into one of them, an iframe and a popup pointing at one, and a name that
 * "resolves" to loopback through the injected resolver. `CAPTURE_FIXTURE=1` also writes the form page's
 * real AXTree to `fixtures/ax-local-form.json` (the snapshot's pure test reads it).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { parseActionArgs, type BrowserAction } from './browser-action-spec'
import { runAction } from './browser-actions'
import { createBrowserHost } from './browser-host'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const log = (...a: unknown[]) => console.log('[browser-s2]', ...a)

const dataDir = mkdtempSync(join(tmpdir(), 'browser-s2-'))
const hits: string[] = []
const secret = (name: string) => RUN ? Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req, srv) { hits.push(`${name} ${new URL(req.url).pathname}`); if (srv.upgrade(req)) return; return new Response('SECRET') },
  websocket: { open() { hits.push(`${name} WS-OPEN`) }, message() {} },
}) : null
const agentA = secret('agentA')
const agentB = secret('agentB')
const neighbour = secret('neighbour')

const form = `<!doctype html><html><head><title>Form page</title></head><body>
<h1>Sign in</h1>
<p>Use your work e-mail.</p>
<label>Name <input id="name" name="name"></label>
<label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option></select></label>
<button id="go" type="button" onclick="document.getElementById('out').textContent='hello ' + document.getElementById('name').value + ' ' + document.getElementById('color').value">Go</button>
<a href="/page2">Next page</a>
<div id="out"></div>
<div style="height:3000px"></div><button id="far" onclick="this.textContent='far clicked'">Far</button>
</body></html>`

const app = RUN ? Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req) {
    const u = new URL(req.url)
    const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html' } })
    if (u.pathname === '/') return html(form)
    if (u.pathname === '/page2') return html('<title>Second</title><p>second page</p>')
    if (u.pathname === '/redir') return Response.redirect(`http://127.0.0.1:${agentA!.port}/api/data`, 302)
    if (u.pathname === '/redir-name') return Response.redirect(`http://sneaky.test:${agentB!.port}/api/data`, 302)
    if (u.pathname === '/redir-neighbour') return Response.redirect(`http://localhost:${neighbour!.port}/json/version`, 307)
    if (u.pathname === '/frame') return html(`<title>Frame</title><iframe src="http://[::1]:${agentA!.port}/framed"></iframe><iframe src="http://localhost:${agentB!.port}/framed2"></iframe>`)
    if (u.pathname === '/popup') return html(`<title>Popup</title><script>window.open("http://127.0.0.1:${agentA!.port}/popup")</script>`)
    if (u.pathname === '/ws') return html(`<title>WS</title><script>new WebSocket("ws://127.0.0.1:${agentA!.port}/ws")</script>`)
    if (u.pathname === '/fetch') return html(`<title>Fetch</title><script>fetch("http://127.0.0.1:${agentB!.port}/api/x").then(r=>r.text()).then(t=>document.title='GOT '+t, e=>document.title='FAILED')</script>`)
    return new Response('nf', { status: 404 })
  },
}) : null

const host = RUN ? createBrowserHost({
  dataDir,
  agentisticsPorts: [agentA!.port!, agentB!.port!],
  debugPorts: () => [neighbour!.port!],
  resolve: async (h) => (h === 'sneaky.test' ? ['127.0.0.1'] : []),
  memAvailable: async () => (await readMemory())?.available ?? null,
  log,
}) : null
const KEY = 's-s2it'
const APP = () => `http://localhost:${app!.port}`

async function act(action: BrowserAction, body: Record<string, unknown> = {}) {
  const p = parseActionArgs(action, body)
  if (!p.ok) throw new Error(p.sentence)
  const h = host!.actionHost(KEY)
  if (!h) throw new Error('no browser')
  const r = await runAction(h, p.args)
  log(action, JSON.stringify(r).slice(0, 300))
  return r as Record<string, any>
}

afterAll(async () => {
  await host?.stopAll('requested')
  for (const s of [app, agentA, agentB, neighbour]) s?.stop(true)
  const left = existsSync(join(dataDir, 'browser', 'sessions')) ? readdirSync(join(dataDir, 'browser', 'sessions')) : []
  log('profile folders left:', left.length)
  rmSync(dataDir, { recursive: true, force: true })
})

d('S2 verbs on a real headless shell', () => {
  test('start, navigate the local app, snapshot with refs', async () => {
    const r = await host!.start({ kind: 'session', managedId: 's2it' })
    expect(r.ok).toBe(true)
    const nav = await act('navigate', { url: `${APP()}/` })
    expect(nav).toMatchObject({ ok: true, title: 'Form page' })
    const snap = await act('snapshot')
    expect(snap.ok).toBe(true)
    expect(snap.snapshot).toMatch(/- textbox "Name" \[ref=e\d+@g\d+\]/)
    expect(snap.snapshot).toMatch(/- combobox "Color"/)
    expect(snap.snapshot).toMatch(/- button "Go" \[ref=e\d+@g\d+\]/)
    expect(snap.snapshot).toContain('- text "Use your work e-mail."')
    if (process.env.CAPTURE_FIXTURE === '1') {
      const h = host!.actionHost(KEY)!
      const sid = await h.sessionFor(h.activeTab()!)
      const { nodes } = await h.cdp.send<{ nodes: unknown[] }>('Accessibility.getFullAXTree', {}, sid)
      mkdirSync(join(import.meta.dir, 'fixtures'), { recursive: true })
      writeFileSync(join(import.meta.dir, 'fixtures', 'ax-local-form.json'), JSON.stringify(nodes, null, 1))
      log('fixture written', nodes.length, 'nodes')
    }
  }, 60_000)

  test('type, select and click by ref; the page sees all three', async () => {
    const snap = (await act('snapshot')).snapshot as string
    const ref = (re: RegExp) => re.exec(snap)![1]!
    const name = ref(/textbox "Name" \[ref=(e\d+@g\d+)\]/)
    const color = ref(/combobox "Color"[^\n]*\[ref=(e\d+@g\d+)\]/)
    const go = ref(/button "Go" \[ref=(e\d+@g\d+)\]/)
    expect((await act('type', { ref: name, text: 'alice' })).ok).toBe(true)
    expect((await act('type', { ref: name, text: 'bob' })).ok).toBe(true) // replaces, never appends
    expect((await act('select', { ref: color, values: ['Green'] })).selected).toBe(1)
    const c = await act('click', { ref: go })
    expect(c).toMatchObject({ ok: true, clicked: 'Go' })
    const out = await act('evaluate', { expression: "document.getElementById('out').textContent" })
    expect(out.value).toBe('"hello bob g"')
  }, 60_000)

  test('click a button 3000 px below the fold by ref; viewport snapshot shows only the visible part', async () => {
    // Contract (S2 fix 2): ANY new snapshot voids the refs of the one before, so the ref used is from the LAST one.
    const before = (await act('snapshot')).snapshot as string
    const old = /button "Far" \[ref=(e\d+@g\d+)\]/.exec(before)![1]!
    const vp = (await act('snapshot', { mode: 'viewport' })).snapshot as string
    expect(await act('click', { ref: old })).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(vp).not.toContain('"Far"')
    const full = (await act('snapshot')).snapshot as string
    const far = /button "Far" \[ref=(e\d+@g\d+)\]/.exec(full)![1]!
    expect(await act('click', { ref: far })).toMatchObject({ ok: true, clicked: 'Far' })
    expect((await act('evaluate', { expression: "document.getElementById('far').textContent" })).value).toBe('"far clicked"')
    const vp2 = (await act('snapshot', { mode: 'viewport' })).snapshot as string
    expect(vp2).toContain('far clicked')
    expect(vp2).not.toContain('"Sign in"')
  }, 60_000)

  test('a stale ref is said in words; evaluate is capped at 20 KB; wait_for and press work', async () => {
    expect(await act('click', { ref: 'e999999' })).toMatchObject({ ok: false, error: 'stale_ref' })
    const big = await act('evaluate', { expression: "'x'.repeat(100000)" })
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.value, 'utf8')).toBeLessThanOrEqual(20 * 1024)
    expect(await act('evaluate', { expression: 'throw new Error("boom")' })).toMatchObject({ ok: false, error: 'script_error' })
    expect((await act('wait_for', { text: 'Sign in', timeoutMs: 2000 })).found).toBe(true)
    expect((await act('wait_for', { text: 'never there', timeoutMs: 500 })).found).toBe(false)
    expect((await act('press', { key: 'Tab' })).ok).toBe(true)
  }, 60_000)

  test('tabs: new, list, select, close, ceiling', async () => {
    const t1 = await act('tab_new', { url: `${APP()}/page2` })
    expect(t1).toMatchObject({ ok: true, title: 'Second' })
    const list = await act('tabs')
    expect(list.tabs.length).toBe(2)
    expect(list.tabs.find((t: any) => t.active).tab).toBe(t1.tab)
    const first = list.tabs.find((t: any) => !t.active).tab
    expect((await act('tab_select', { tab: first })).ok).toBe(true)
    expect((await act('snapshot')).title).toBe('Form page')
    await act('tab_new'); await act('tab_new')
    expect(await act('tab_new')).toMatchObject({ ok: false, error: 'tab_ceiling' })
    for (const t of (await act('tabs')).tabs) if (t.tab !== first) expect((await act('tab_close', { tab: t.tab })).ok).toBe(true)
    expect((await act('tabs')).tabs.length).toBe(1)
  }, 60_000)

  test('screenshot returns a real PNG', async () => {
    const s = await act('screenshot')
    expect(s.mime).toBe('image/png')
    expect(Buffer.from(s.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
    if (process.env.S2_SHOT_DIR) writeFileSync(join(process.env.S2_SHOT_DIR, 's2-form.png'), Buffer.from(s.data, 'base64'))
  }, 60_000)
})

d('S2 block rules, proven in the browser', () => {
  test('agentistics ports, file:, the neighbour debug port and a loopback NAME are refused before loading', async () => {
    const before = hits.length
    for (const url of [
      `http://127.0.0.1:${agentA!.port}/api/data`, `http://localhost:${agentB!.port}/`, `http://[::1]:${agentA!.port}/`,
      `http://0x7f000001:${agentA!.port}/`, 'file:///etc/passwd', 'chrome://settings', `http://127.0.0.1:${neighbour!.port}/json/version`,
      `http://sneaky.test:${agentA!.port}/`,
    ]) {
      const r = await act('navigate', { url })
      expect(r).toMatchObject({ ok: false, error: 'blocked' })
    }
    expect(hits.slice(before)).toEqual([])
  }, 60_000)

  test('another localhost port (the dev server) is allowed', async () => {
    expect((await act('navigate', { url: `http://127.0.0.1:${app!.port}/page2` })).ok).toBe(true)
  }, 30_000)

  test('a REDIRECT to a blocked address is refused, and says it was a redirect', async () => {
    const before = hits.length
    for (const path of ['/redir', '/redir-name', '/redir-neighbour']) {
      const r = await act('navigate', { url: `${APP()}${path}` })
      expect(r).toMatchObject({ ok: false, error: 'blocked', redirect: true })
      expect(r.sentence).toContain('redirected')
    }
    expect(hits.slice(before)).toEqual([])
  }, 60_000)

  test('iframes, a popup and fetch() from the page reach nothing blocked', async () => {
    const before = hits.length
    expect((await act('navigate', { url: `${APP()}/frame` })).ok).toBe(true)
    expect((await act('navigate', { url: `${APP()}/fetch` })).ok).toBe(true)
    await act('wait_for', { ms: 600 })
    expect((await act('snapshot')).title).toBe('FAILED')
    expect((await act('navigate', { url: `${APP()}/popup` })).ok).toBe(true)
    await act('wait_for', { ms: 800 })
    expect(hits.slice(before)).toEqual([])
    const st = await host!.status()
    const blocked = st.live[0]!.blocked
    log('status.blocked', JSON.stringify(blocked))
    expect(blocked.length).toBeGreaterThan(0)
    for (const b of blocked) expect(b.url).not.toContain('?')
    // the popup tab is open but empty; close extras
    for (const t of (await act('tabs')).tabs) if (!t.active) await act('tab_close', { tab: t.tab })
  }, 60_000)

  test('a WebSocket to a blocked address: the tab is closed and the attempt recorded (stated limit: not prevented)', async () => {
    await act('tab_new', { url: `${APP()}/page2` })
    const wsTab = (await act('tab_new')).tab as string
    const r = await act('navigate', { url: `${APP()}/ws`, tab: wsTab })
    log('ws navigate', JSON.stringify(r), 'hits', JSON.stringify(hits.filter(h => h.includes('WS'))))
    await new Promise(res => setTimeout(res, 1500))
    const tabs = (await act('tabs')).tabs.map((t: any) => t.tab)
    expect(tabs).not.toContain(wsTab)
    const st = await host!.status()
    expect(st.live[0]!.blocked.some(b => b.resourceType === 'WebSocket')).toBe(true)
  }, 60_000)

  test('status keeps tab URLs to origin+path and no data: content', async () => {
    await act('navigate', { url: `data:text/html,<title>${'T'.repeat(300)}</title>${'x'.repeat(5000)}` }).catch(() => null)
    const st = await host!.status()
    for (const t of st.live[0]!.tabs) {
      expect(t.url.length).toBeLessThanOrEqual(300)
      expect(t.title.length).toBeLessThanOrEqual(120)
      expect(t.url).not.toContain('xxxx')
    }
    const raw = readFileSync(join(dataDir, 'browser', 'pids.json'), 'utf8')
    expect(JSON.parse(raw)[0].hostStart).toBeGreaterThan(0)
  }, 30_000)
})
