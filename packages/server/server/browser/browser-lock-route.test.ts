/**
 * The padlock at the `/api/browser/*` door (NAVEGADOR S3), over a FAKE host and a fake clock: a held action
 * is never run, reads go on, only the person changes the padlock, and the HMAC proof decides whose browser.
 */
import { describe, expect, test } from 'bun:test'
import { browserRoute, type RouteDeps, type RouteHost } from './browser-web'
import { BrowserLocks } from './browser-lock-host'
import { ownerProofRefusal } from './browser-lock'
import type { ActionHost } from './browser-actions'
import type { BrowserOwner } from './browser-spec'

function fixture(over: Partial<RouteDeps> = {}) {
  let now = 1_800_000_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let seq = 0
  const locks = new BrowserLocks({
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer: (t) => { timers.delete(t as number) },
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn() }
  }
  const live = new Set<string>()
  const ran: Array<{ key: string; action: string }> = []
  const audits: string[] = []
  const keyOf = (o: BrowserOwner) => (o.kind === 'personal' ? 'personal' : `s-${o.managedId}`)
  const host: RouteHost = {
    start: async (o) => { live.add(keyOf(o)); return { ok: true, key: keyOf(o), pid: 1, reused: false } },
    stop: async (k) => { live.delete(k) },
    actionHost: (k) => (live.has(k)
      ? ({ key: k, tabs: () => [{ targetId: 'T1', url: 'http://localhost:5173/login?token=zzz', title: 'Login', active: true }] } as unknown as ActionHost)
      : null),
    status: async () => ({ live: [...live].map(k => ({ key: k, owner: k === 'personal' ? { kind: 'personal' } : { kind: 'session', managedId: k.slice(2) } })) }),
  }
  const deps: RouteDeps = {
    host,
    verify: async (id, token) => (typeof id === 'string' && token === `good-${id}` ? id : null),
    run: async (h, args) => { ran.push({ key: (h as any).key, action: args.action }); return { ok: true, action: args.action } },
    locks,
    harnessOf: (id) => (id === 'cla' ? 'claude' : id === 'ope' ? 'opencode' : undefined),
    audit: (ev) => audits.push(`${ev.action}:${ev.managedId}`),
    // S4/F1: the socket says who is calling. These tests are about the padlock's rules, so the caller is
    // the person unless a test says otherwise (the F1 tests below do).
    caller: () => ({ kind: 'person', via: 'process', pid: 1 }),
    // S4b: and the person carries a valid vault proof, unless a test says otherwise (the S4b tests below do).
    ownerProof: async () => ({ ok: true, grantId: 'g' }),
    ...over,
  }
  return { deps, ran, audits, advance, live, locks }
}

const proof = (id: string) => ({ id, token: `good-${id}` })
const call = (f: ReturnType<typeof fixture>, verb: string, body: Record<string, unknown>) => browserRoute('POST', `/api/browser/session/${verb}`, body, f.deps)
const tick = () => new Promise(r => setTimeout(r, 0))

describe('the padlock at the door', () => {
  test('locked (the default): actions and reads run', async () => {
    const f = fixture()
    expect((await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' }))?.body).toEqual({ ok: true, action: 'navigate' })
    expect((await call(f, 'click', { session: proof('aaa'), ref: 'e1@g1' }))?.body).toEqual({ ok: true, action: 'click' })
    expect(f.ran.map(r => r.action)).toEqual(['navigate', 'click'])
  })

  test('unlocked: a held action does NOT run; the person locks → "not done" with the page now; reads run meanwhile', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    expect(await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)).toMatchObject({ status: 200, body: { ok: true, lock: 'unlocked', changed: true } })
    let answer: any = null
    void call(f, 'click', { session: proof('aaa'), ref: 'e1@g1' }).then(a => { answer = a })
    await tick()
    expect(answer).toBeNull()
    // reads keep working while the person drives
    expect((await call(f, 'snapshot', { session: proof('aaa') }))?.body).toEqual({ ok: true, action: 'snapshot' })
    expect((await call(f, 'tabs', { session: proof('aaa') }))?.body).toEqual({ ok: true, action: 'tabs' })
    f.advance(30_000)
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'locked' }, f.deps)
    await tick()
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: true, performed: false, reason: 'person_returned' })
    expect(String(answer.body.sentence)).toContain('Login — http://localhost:5173/login')
    expect(String(answer.body.sentence)).not.toContain('token=zzz') // sanitised like the status
    expect(f.ran.map(r => r.action)).toEqual(['navigate', 'snapshot', 'tabs'])
    expect(f.audits).toEqual(['browser.unlock:aaa', 'browser.lock:aaa'])
  })

  test('unlocked: the deadline is the harness\'s — opencode 55 s, claude 125 s — and answers "not done"', async () => {
    for (const [id, hold] of [['ope', 55_000], ['cla', 125_000], ['unk', 50_000]] as const) {
      const f = fixture()
      await call(f, 'navigate', { session: proof(id), url: 'http://x/' })
      await browserRoute('POST', '/api/browser/lock', { owner: id, lock: 'unlocked' }, f.deps)
      let answer: any = null
      void call(f, 'type', { session: proof(id), ref: 'e2@g1', text: 'x' }).then(a => { answer = a })
      await tick()
      f.advance(hold - 1); await tick()
      expect(answer).toBeNull()
      f.advance(1); await tick()
      expect(answer.body).toMatchObject({ ok: false, performed: false, error: 'person_driving' })
      expect(f.ran.map(r => r.action)).toEqual(['navigate'])
    }
  })

  test('a session can NEVER change the padlock — its own proof, another\'s, a forged or empty one', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    for (const session of [proof('aaa'), proof('bbb'), { id: 'aaa', token: 'forged' }, { id: 'aaa', token: '' }, {}]) {
      for (const lock of ['unlocked', 'locked']) {
        const r = await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock, session }, f.deps)
        expect(r).toMatchObject({ status: 403, body: { ok: false, error: 'session_cannot_unlock' } })
      }
    }
    expect(f.locks.view('s-aaa').mode).toBe('locked')
    expect(f.audits).toEqual([])
  })

  test('the person: unlocking a browser that is not open is refused; personal has no padlock; GET is 405', async () => {
    const f = fixture()
    expect(await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)).toMatchObject({ status: 409, body: { error: 'no_browser' } })
    expect(await browserRoute('POST', '/api/browser/lock', { owner: 'personal', lock: 'unlocked' }, f.deps)).toMatchObject({ status: 400, body: { error: 'personal_has_no_lock' } })
    expect((await browserRoute('GET', '/api/browser/lock', undefined, f.deps))?.status).toBe(405)
    // locking is idempotent and needs no browser
    expect(await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'locked' }, f.deps)).toMatchObject({ status: 200, body: { changed: false } })
    expect(f.audits).toEqual([])
  })

  test('HMAC: another session\'s token reaches neither the verbs nor wait_unlock, and holds nothing', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)
    const forged = { id: 'aaa', token: 'good-bbb' }
    expect(await call(f, 'click', { session: forged, ref: 'e1@g1' })).toMatchObject({ status: 403, body: { error: 'unverified_session' } })
    expect(await call(f, 'wait_unlock', { session: forged })).toMatchObject({ status: 403, body: { error: 'unverified_session' } })
    expect(await call(f, 'wait_unlock', {})).toMatchObject({ status: 403, body: { error: 'unverified_session' } })
    expect(f.locks.view('s-aaa').held).toBe(0)
    // bbb's own proof drives bbb's browser, which is locked: it runs
    expect((await call(f, 'navigate', { session: proof('bbb'), url: 'http://x/' }))?.body).toEqual({ ok: true, action: 'navigate' })
  })

  test('wait_unlock: at once when locked; answers when the person locks; needs no browser and starts none', async () => {
    const f = fixture()
    expect(await call(f, 'wait_unlock', { session: proof('aaa') })).toMatchObject({ status: 200, body: { ok: true, locked: true, waitedMs: 0 } })
    expect(f.live.size).toBe(0)
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)
    let w: any = null
    void call(f, 'wait_unlock', { session: proof('aaa'), maxMs: 999_999 }).then(a => { w = a })
    await tick()
    f.advance(10_000)
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'locked' }, f.deps)
    await tick()
    expect(w.body).toMatchObject({ ok: true, locked: true, waitedMs: 10_000 })
    expect(f.ran.map(r => r.action)).toEqual(['navigate'])
  })

  test('wait_unlock ends at its own (clamped) deadline still unlocked', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('ope'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/lock', { owner: 'ope', lock: 'unlocked' }, f.deps)
    let w: any = null
    void call(f, 'wait_unlock', { session: proof('ope'), maxMs: 999_999 }).then(a => { w = a })
    await tick()
    f.advance(55_000); await tick()
    expect(w.body).toMatchObject({ ok: true, locked: false, waitedMs: 55_000 })
  })

  test('a session that is not running cannot wait either', async () => {
    const f = fixture({ sessionLive: () => false })
    expect(await call(f, 'wait_unlock', { session: proof('aaa') })).toMatchObject({ status: 403, body: { error: 'session_not_running' } })
  })

  test('the status carries each session browser\'s padlock; the personal one carries none', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/personal/navigate', { url: 'http://x/' }, { ...f.deps, caller: () => ({ kind: 'person', via: 'process', pid: 1 }) })
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)
    const st = (await browserRoute('GET', '/api/browser/status', undefined, f.deps))!.body as { live: any[] }
    expect(st.live.find(e => e.key === 's-aaa').lock).toMatchObject({ mode: 'unlocked', held: 0 })
    expect(st.live.find(e => e.key === 'personal').lock).toBeUndefined()
  })

  test('the personal browser is never held (it has no padlock), even with session padlocks open', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)
    expect((await browserRoute('POST', '/api/browser/personal/navigate', { url: 'http://x/' }, { ...f.deps, caller: () => ({ kind: 'person', via: 'process', pid: 1 }) }))?.body).toEqual({ ok: true, action: 'navigate' })
  })

  // QA S3 mutant Q1: marking `evaluate` as a read passed every test. It is an ACTION (it runs code on the page).
  test('unlocked: EVERY action is held — evaluate and close included — and none runs', async () => {
    const f = fixture()
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'unlocked' }, f.deps)
    f.ran.length = 0
    const pending: Array<Promise<unknown>> = []
    for (const [verb, extra] of [['evaluate', { expression: '1+1' }], ['click', { ref: 'e1@g1' }], ['close', {}]] as const) {
      let settled = false
      const p = call(f, verb, { session: proof('aaa'), ...extra }).then(a => { settled = true; return a })
      pending.push(p)
      await tick()
      expect([verb, settled]).toEqual([verb, false]) // held, not answered
    }
    expect(f.ran).toEqual([])
    expect(f.live.has('s-aaa')).toBe(true) // close was held too: the browser is still there
    f.advance(50_000)
    const answers = await Promise.all(pending) as Array<{ body: { performed?: boolean } }>
    for (const a of answers) expect(a.body.performed).toBe(false)
    expect(f.ran).toEqual([])
  })
})

describe('F1 — the padlock is the PERSON\'s, decided by the socket, never by the body', () => {
  const body = { owner: 'aaa', lock: 'unlocked' }
  test('a caller inside a session tree is refused, with session absent, null or under another name', async () => {
    const f = fixture({ caller: () => ({ kind: 'session', pid: 4242, managedId: 'aaa' }) })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    for (const b of [body, { ...body, session: null }, { ...body, sessionId: 'aaa' }, { ...body, Session: proof('aaa') }, { ...body, identity: 'x' }]) {
      const a = await browserRoute('POST', '/api/browser/lock', b, f.deps)
      expect(a).toMatchObject({ status: 403, body: { error: 'session_cannot_unlock' } })
    }
    expect(f.locks.view('s-aaa').mode).toBe('locked')
    expect(f.audits).toEqual([])
  })

  test('a known session is refused even when it carries a valid vault grant (the socket layer stays)', async () => {
    let spent = 0
    const f = fixture({ caller: () => ({ kind: 'session', pid: 4242, managedId: null }), ownerProof: async () => { spent++; return { ok: true, grantId: 'g' } } })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 403, body: { error: 'session_cannot_unlock' } })
    expect(spent).toBe(0) // refused before the grant is touched
    expect(f.locks.view('s-aaa').mode).toBe('locked')
  })

  test('S4b: a caller that cannot be identified (macOS, Windows, no /proc) is decided by the proof, not refused outright', async () => {
    for (const caller of [() => ({ kind: 'unknown', reason: 'no-proc' }) as const, undefined]) {
      const denied = fixture({ caller, ownerProof: async () => ownerProofRefusal('grant-invalid', 'en', false) })
      await call(denied, 'navigate', { session: proof('aaa'), url: 'http://x/' })
      expect(await browserRoute('POST', '/api/browser/lock', body, denied.deps)).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
      expect(denied.locks.view('s-aaa').mode).toBe('locked')
      const proven = fixture({ caller })
      await call(proven, 'navigate', { session: proof('aaa'), url: 'http://x/' })
      expect(await browserRoute('POST', '/api/browser/lock', body, proven.deps)).toMatchObject({ status: 200, body: { lock: 'unlocked' } })
      // locking only reduces exposure: it needs no proof
      expect(await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'locked' }, denied.deps)).toMatchObject({ status: 200, body: { lock: 'locked' } })
    }
  })

  test('the person (process outside every session, the WSL relay, another machine) unlocks', async () => {
    for (const v of [{ kind: 'person', via: 'process', pid: 9 }, { kind: 'person', via: 'wsl-relay' }, { kind: 'person', via: 'remote' }] as const) {
      const f = fixture({ caller: () => v })
      await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
      expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 200, body: { ok: true, lock: 'unlocked' } })
    }
  })
})

describe('S4b — an unlock owes the person\'s vault proof; who the process looks like is only a hint', () => {
  const body = { owner: 'aaa', lock: 'unlocked' }
  test('"the person" by /proc (a detached session with a clean env looks exactly like this) WITHOUT the proof is refused', async () => {
    const f = fixture({ ownerProof: async () => ownerProofRefusal('grant-invalid', 'en', false) })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    const a = await browserRoute('POST', '/api/browser/lock', body, f.deps)
    expect(a).toMatchObject({ status: 403, body: { ok: false, error: 'owner_proof_required' } })
    expect(String((a?.body as { sentence: string }).sentence)).toContain('Vault password')
    expect(f.locks.view('s-aaa').mode).toBe('locked')
    expect(f.audits).toEqual([])
  })

  test('S4c: the browser closes WHILE the proof is checked ⇒ 409 no_browser, no unlock, no audit, padlock untouched', async () => {
    const f = fixture({ ownerProof: async () => { f.live.delete('s-aaa'); return { ok: true, grantId: 'g' } } })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    const a = await browserRoute('POST', '/api/browser/lock', body, f.deps)
    expect(a).toMatchObject({ status: 409, body: { ok: false, error: 'no_browser' } })
    expect(f.locks.view('s-aaa').mode).toBe('locked')
    expect(f.audits).toEqual([])
  })

  test('a door wired WITHOUT the proof refuses every unlock (absent = no proof possible, fail-closed)', async () => {
    const f = fixture({ ownerProof: undefined })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 403, body: { error: 'owner_proof_required' } })
    expect(f.locks.view('s-aaa').mode).toBe('locked')
  })

  test('the proof is asked for THAT browser, once per unlock; locking never asks it', async () => {
    const asked: string[] = []
    const f = fixture({ ownerProof: async (id) => { asked.push(id); return { ok: true, grantId: 'g' } } })
    await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
    expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 200, body: { lock: 'unlocked' } })
    expect(await browserRoute('POST', '/api/browser/lock', { owner: 'aaa', lock: 'locked' }, f.deps)).toMatchObject({ status: 200, body: { lock: 'locked' } })
    expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 200, body: { lock: 'unlocked' } })
    expect(asked).toEqual(['aaa', 'aaa'])
    expect(f.audits).toEqual(['browser.unlock:aaa', 'browser.lock:aaa', 'browser.unlock:aaa'])
  })

  test('no browser open → 409 and the grant is NOT spent (the retry can use it)', async () => {
    let spent = 0
    const f = fixture({ ownerProof: async () => { spent++; return { ok: true, grantId: 'g' } } })
    expect(await browserRoute('POST', '/api/browser/lock', body, f.deps)).toMatchObject({ status: 409, body: { error: 'no_browser' } })
    expect(spent).toBe(0)
  })

  test('the refusal carries the vault\'s words and, where the vault cannot ask anyone, the action that fixes it', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const f = fixture({ ownerProof: async () => ownerProofRefusal('grant-invalid', lang, true) })
      await call(f, 'navigate', { session: proof('aaa'), url: 'http://x/' })
      const a = await browserRoute('POST', '/api/browser/lock', body, f.deps)
      expect(a).toMatchObject({ status: 403, body: { error: 'owner_proof_unavailable', action: { kind: 'open-vault', path: '/vault' } } })
      const s = String((a?.body as { sentence: string }).sentence)
      expect(s).toContain(lang === 'pt' ? 'Abra o Cofre' : 'Open the Vault')
      expect(s).not.toMatch(/agentop|run |terminal/i) // users are not technical: the action, never a command
    }
  })

  test('ownerProofRefusal: every code has a pt and an en sentence', () => {
    for (const code of ['grant-invalid', 'grant-scope', 'owner-proof-local-only'] as const) {
      for (const setup of [false, true]) {
        const en = ownerProofRefusal(code, 'en', setup); const pt = ownerProofRefusal(code, 'pt', setup)
        expect(en.status).toBe(403)
        expect(en.sentence.length).toBeGreaterThan(20)
        expect(pt.sentence).not.toBe(en.sentence)
      }
    }
    expect(ownerProofRefusal('grant-scope', 'en', false).error).toBe('owner_proof_scope')
    expect(ownerProofRefusal('owner-proof-local-only', 'en', true).error).toBe('owner_proof_local_only')
  })
})
