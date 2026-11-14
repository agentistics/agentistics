/**
 * eg-integ r4 (closes QA r3 R2) — the wiring `index.ts` uses, driven end to end with the REAL mode reader.
 *
 * `index.ts` builds its principal deps through `taskRequestDeps` / `taskAuthorField` / `threadOpenKnown`
 * (`request-deps.ts`), which fix `mode: readOwnerProofMode`. Each scenario runs in its own process pointed at its own
 * `AGENTISTICS_DIR` (`loadTaskWorld()` and the preferences file resolve their paths once from the env), so legacy and
 * required are the real thing: an absent preference reads `legacy`, `delivery.ownerProof: 'required'` reads `required`.
 *
 *   Q1b/Q1c — a hardcoded `required` in the wiring makes every legacy rename 403 (B1): the 200 + stored title test.
 *   Q3      — a topic open that ignores a proven session (W3a): the opener must be the session id.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SERVER = join(HERE, '..')

async function run(mode: 'legacy' | 'required', body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'eg-r4-'))
  const script = `
    const { updatePreferences } = await import(${JSON.stringify(join(SERVER, 'preferences.ts'))})
    ${mode === 'required' ? "await updatePreferences(() => ({ delivery: { ownerProof: 'required' } }))" : ''}
    const { taskRequestDeps, taskAuthorField, threadOpenKnown } = await import(${JSON.stringify(join(HERE, 'request-deps.ts'))})
    const { screenTaskRequest } = await import(${JSON.stringify(join(HERE, 'principal-http.ts'))})
    const web = await import(${JSON.stringify(join(SERVER, 'sessions', 'task-web.ts'))})
    const src = await import(${JSON.stringify(join(SERVER, 'sessions', 'task-source.ts'))})
    const th = await import(${JSON.stringify(join(SERVER, 'sessions', 'task-threads.ts'))})
    const WEB = { originOwn: true, sameOriginFetch: true, loopbackPeer: true }
    const io = { verify: async (id, token) => (id === 'w1' && token === 'ok' ? 'w1' : null), consumeGrant: () => ({ ok: false, code: 'grant-invalid' }) }
    const post = async (path, payload, browser = WEB) => {
      const deps = await taskRequestDeps(() => browser, io)
      return screenTaskRequest({ path, method: 'POST', contentType: 'application/json', text: async () => JSON.stringify(payload) }, deps.verify, deps)
    }
    const out = await (async () => { ${body} })()
    console.log('@@' + JSON.stringify(out))
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  await proc.exited
  await rm(dir, { recursive: true, force: true })
  const line = text.split('\n').find(l => l.startsWith('@@'))
  if (!line) throw new Error(`child produced no result\n${text}\n${err}`)
  return JSON.parse(line.slice(2))
}

const rename = (browser = 'WEB') => `
  const t = await web.createTask({ title: 'Old name' })
  const screened = await post('/api/tasks/' + t.id, { title: 'New name', actor: 'you' }, ${browser})
  const status = screened ? screened.status : 200
  if (!screened) await web.editTask(t.id, { title: 'New name', actor: 'you' })
  const after = (await src.loadTaskWorld()).book.tasks.find(x => x.id === t.id)
  return { status, error: screened?.body?.error ?? null, title: after.title }
`

describe('real wiring — the board\'s Rename (actor "you")', () => {
  test('legacy: 200 and the title is stored (B1) — also without browser headers', async () => {
    const r = await run('legacy', rename())
    expect(r).toEqual({ status: 200, error: null, title: 'New name' })
    const bare = await run('legacy', rename('{ loopbackPeer: false, originOwn: false, sameOriginFetch: false }'))
    expect(bare.status).toBe(200)
    expect(bare.title).toBe('New name')
  })
  test('required without proof: refused owner_proof_required, the title is NOT stored', async () => {
    const r = await run('required', rename())
    expect(r).toEqual({ status: 403, error: 'owner_proof_required', title: 'Old name' })
  })
})

describe('real wiring — a thread open (W3a/W3b)', () => {
  const OPEN = (payload: string, gate = 'async () => null') => `
    const t = await web.createTask({ title: 'T' })
    const body = ${payload}
    const opened = await threadOpenKnown(body, t.id, ${gate}, io)
    if (opened.denied) return { denied: opened.denied.status }
    const author = await taskAuthorField(body.author ?? 'owner', 'thread:open', t.id, opened.known, body, () => taskRequestDeps(() => WEB, io))
    if (!author.ok) return { refused: author.reply.status }
    const res = await th.openThread(t.id, { title: 'A topic', openedBy: author.value, kind: 'topic' })
    return { openedBy: res.ok ? res.thread.openedBy : null }
  `
  test('required + a proven session: the thread records the SESSION id, never the typed owner name (Q3)', async () => {
    expect(await run('required', OPEN("{ author: 'owner', session: { id: 'w1', token: 'ok' } }"))).toEqual({ openedBy: 'w1' })
  })
  test('required + a proven session that also says owner:true: the session wins, the owner gate is never asked (Q3)', async () => {
    expect(await run('required', OPEN("{ author: 'owner', owner: true, session: { id: 'w1', token: 'ok' } }", "async () => ({ status: 403, body: { error: 'owner_proof_required' } })"))).toEqual({ openedBy: 'w1' })
  })
  test('required + an unproven session claiming "owner": refused so_o_dono', async () => {
    expect(await run('required', OPEN("{ author: 'owner', session: { id: 'w1', token: 'bad' } }"))).toEqual({ refused: 403 })
  })
  test('legacy keeps the typed name (no gate, no proof)', async () => {
    expect(await run('legacy', OPEN("{ author: 'you', owner: true }", 'async () => { throw new Error("gate must not run in legacy") }'))).toEqual({ openedBy: 'you' })
  })
  test('required + owner:true without a grant: the owner gate decides (W3b)', async () => {
    expect(await run('required', OPEN("{ author: 'you', owner: true }", "async () => ({ status: 403, body: { error: 'owner_proof_required' } })"))).toEqual({ denied: 403 })
  })
})

describe('index.ts uses the factory and cannot override the mode', () => {
  test('no inline `mode:` in the task-write wiring; the factory fixes readOwnerProofMode', async () => {
    const idx = await Bun.file(join(SERVER, 'index.ts')).text()
    const start = idx.indexOf('ENTREGA.GARANTIDA §2.3: a task WRITE may not claim')
    const wiring = idx.slice(start, start + 1800)
    expect(wiring).toContain('taskRequestDeps(')
    expect(wiring).not.toMatch(/mode:/)
    expect(idx).toContain('threadOpenKnown(')
    expect(idx).toContain('taskAuthorField(')
    const factory = await Bun.file(join(HERE, 'request-deps.ts')).text()
    expect(factory).toContain('mode: readOwnerProofMode')
  })
})
