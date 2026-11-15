/**
 * S2 fix 2, on a real headless shell (BROWSER_INTEGRATION=1 under `agentop run --rm`): a ref taken on one
 * document never acts on another. Page A and page B put a button in the SAME place with the SAME DOM shape,
 * so both get the same backend node id; B's button is the dangerous one ("Delete everything").
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseActionArgs, type BrowserAction } from './browser-action-spec'
import { runAction } from './browser-actions'
import { createBrowserHost } from './browser-host'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const dataDir = mkdtempSync(join(tmpdir(), 'browser-s2refs-'))
const page = (title: string, label: string, mark: string) =>
  `<!doctype html><title>${title}</title><button id="b" onclick="document.title='${mark}'">${label}</button><a href="/b">go b</a>`
const app = RUN ? Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req) {
    const p = new URL(req.url).pathname
    const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html' } })
    if (p === '/a') return html(page('A', 'Keep', 'CLICKED-A'))
    if (p === '/b') return html(page('B', 'Delete everything', 'WRONG-B'))
    if (p === '/pop') return html(`<title>Pop</title><button id="p" onclick="for(let i=0;i<20;i++)window.open('about:blank')">Open many</button><button id="q" onclick="document.title='after'">After</button>`)
    return new Response('nf', { status: 404 })
  },
}) : null
const host = RUN ? createBrowserHost({ dataDir, agentisticsPorts: [], debugPorts: () => [], resolve: async () => [], memAvailable: async () => null, log: () => {} }) : null
const KEY = 's-s2refs'
const URL_ = (p: string) => `http://localhost:${app!.port}${p}`

async function act(action: BrowserAction, body: Record<string, unknown> = {}) {
  const p = parseActionArgs(action, body)
  if (!p.ok) throw new Error(p.sentence)
  const h = host!.actionHost(KEY)
  if (!h) throw new Error('no browser')
  return (await runAction(h, p.args)) as Record<string, any>
}
const refOf = (snap: string, label: string) => new RegExp(`button "${label}" \\[ref=(e\\d+@g\\d+)\\]`).exec(snap)![1]!
const title = async () => JSON.parse((await act('evaluate', { expression: 'document.title' })).value as string) as string

afterAll(async () => {
  await host?.stopAll('requested')
  app?.stop(true)
  rmSync(dataDir, { recursive: true, force: true })
})

d('refs bound to their document', () => {
  test('start', async () => { expect((await host!.start({ kind: 'session', managedId: 's2refs' })).ok).toBe(true) }, 60_000)

  for (const round of [1, 2, 3]) {
    test(`navigation, round ${round}: a ref from A answers stale_ref on B and nothing is clicked`, async () => {
      await act('navigate', { url: URL_('/b') })
      const idB = refOf((await act('snapshot')).snapshot, 'Delete everything').split('@')[0]! // a node that exists on B
      await act('navigate', { url: URL_('/a') })
      const refA = refOf((await act('snapshot')).snapshot, 'Keep')
      const gen = refA.split('@')[1]!
      await act('navigate', { url: URL_('/b') })
      // The real ref from A, and the attack: B's own node id wearing A's snapshot generation.
      for (const ref of [refA, `${idB}@${gen}`]) {
        expect(await act('click', { ref })).toMatchObject({ ok: false, error: 'stale_ref' })
        expect(await title()).toBe('B')
      }
    }, 60_000)
  }

  test('reload: refs from before it are void, a new snapshot works and names the clicked node', async () => {
    await act('navigate', { url: URL_('/a') })
    const refA = refOf((await act('snapshot')).snapshot, 'Keep')
    await act('reload')
    expect(await act('click', { ref: refA })).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(await title()).toBe('A')
    const fresh = refOf((await act('snapshot')).snapshot, 'Keep')
    expect(await act('click', { ref: fresh })).toMatchObject({ ok: true, clicked: 'Keep' })
    expect(await title()).toBe('CLICKED-A')
  }, 60_000)

  test('tab switch: refs of the tab you come back to are void', async () => {
    await act('navigate', { url: URL_('/a') })
    const first = (await act('tabs')).tabs.find((t: any) => t.active).tab
    const refA = refOf((await act('snapshot')).snapshot, 'Keep')
    const other = (await act('tab_new', { url: URL_('/b') })).tab
    await act('tab_select', { tab: first })
    expect(await act('click', { ref: refA })).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(await title()).toBe('A')
    await act('tab_close', { tab: other })
  }, 60_000)

  test('ref from tab 1 sent to tab 2 explicitly is stale too', async () => {
    const first = (await act('tabs')).tabs[0].tab
    await act('tab_select', { tab: first })
    const refA = refOf((await act('snapshot')).snapshot, 'Keep')
    const second = (await act('tab_new', { url: URL_('/b') })).tab
    expect(await act('click', { ref: refA, tab: second })).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(await act('evaluate', { expression: 'document.title', tab: second })).toMatchObject({ value: '"B"' })
    await act('tab_close', { tab: second })
  }, 60_000)

  test('after a popup storm hits the tab ceiling, later actions never time out', async () => {
    await act('navigate', { url: URL_('/pop') })
    const snap = (await act('snapshot')).snapshot
    await act('click', { ref: refOf(snap, 'Open many') })
    await Bun.sleep(1500)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await act('evaluate', { expression: '1+1' })
      seen.push(r.ok ? 'ok' : r.error)
    }
    console.log('post-storm actions:', seen.join(','), 'tabs:', (await act('tabs')).tabs.length)
    expect(seen).not.toContain('timeout')
  }, 90_000)
})
