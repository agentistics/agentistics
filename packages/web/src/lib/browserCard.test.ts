import { afterEach, describe, expect, test } from 'bun:test'
import {
  anchorItemPosition, browserAnchor, browserCaption, containBox, displayUrl, firstBrowserTurn, isAgentisticsBrowserTool,
  lockRefusalSentence, ringAt, sessionBrowserOf, setBrowserLock,
} from './browserCard'

describe('isAgentisticsBrowserTool', () => {
  test('every harness spelling of OUR tools', () => {
    expect(isAgentisticsBrowserTool('agentistics_browser_click')).toBe(true)
    expect(isAgentisticsBrowserTool('mcp__agentistics__agentistics_browser_navigate')).toBe(true)
    expect(isAgentisticsBrowserTool('agentistics__agentistics_browser_tab_new')).toBe(true)
  })
  test('not a third-party browser, not another agentistics tool', () => {
    expect(isAgentisticsBrowserTool('mcp__playwright__browser_click')).toBe(false)
    expect(isAgentisticsBrowserTool('agentistics_task_comment')).toBe(false)
    expect(isAgentisticsBrowserTool('Bash')).toBe(false)
    expect(isAgentisticsBrowserTool('xagentistics_browser_click')).toBe(false)
  })
})

describe('the anchor', () => {
  const t = (tools?: string[]) => ({ tools: tools?.map(name => ({ name })) })
  test('the FIRST browser call, not a later one', () => {
    const turns = [t(), t(['Read']), t(['mcp__agentistics__agentistics_browser_navigate']), t(['mcp__agentistics__agentistics_browser_click'])]
    expect(firstBrowserTurn(turns)).toBe(2)
    expect(browserAnchor(turns, true)).toBe(2)
  })
  test('no call named: the end when the host says the session browses, else no card', () => {
    const turns = [t(), t(['Read'])]
    expect(browserAnchor(turns, true)).toBe(2)
    expect(browserAnchor(turns, false)).toBeNull()
  })
})

describe('anchorItemPosition', () => {
  const turn = (index: number) => ({ type: 'turn' as const, index })
  const act = { type: 'activity' as const }
  test('a turn with text: right after it', () => {
    expect(anchorItemPosition([turn(0), turn(1), turn(2)], 1)).toBe(1)
  })
  test('a turn with text whose calls form the run below it: the card sits between the words and the run', () => {
    expect(anchorItemPosition([turn(0), turn(1), act, turn(4)], 1)).toBe(1)
  })
  test('a call folded into the tool run after the last turn: after that run', () => {
    // turn 0, then turns 1..2 had no text (a run), then turn 3
    expect(anchorItemPosition([turn(0), act, turn(3)], 2)).toBe(1)
  })
  test('anchor before every rendered turn sits before everything', () => {
    expect(anchorItemPosition([turn(5), turn(6)], 2)).toBe(-1)
  })
  test('past the end: after everything', () => {
    expect(anchorItemPosition([turn(0), act], 9)).toBe(1)
    expect(anchorItemPosition([], 0)).toBe(-1)
  })
})

describe('sessionBrowserOf', () => {
  const status = { live: [
    { owner: { kind: 'personal' }, phase: 'live', tabs: [] },
    { owner: { kind: 'session', managedId: 'm1' }, phase: 'live', tabs: [{ targetId: 'T', url: 'https://a/', title: 'A', active: true }] },
    { owner: { kind: 'session', managedId: 'm2' }, phase: 'stopping', tabs: [] },
  ] }
  test('finds this session only', () => {
    expect(sessionBrowserOf(status, 'm1')?.tabs[0]?.targetId).toBe('T')
    expect(sessionBrowserOf(status, 'mX')).toBeNull()
  })
  test('a stopping browser is not one to watch; junk reads as none', () => {
    expect(sessionBrowserOf(status, 'm2')).toBeNull()
    expect(sessionBrowserOf(null, 'm1')).toBeNull()
    expect(sessionBrowserOf({ live: 'x' }, 'm1')).toBeNull()
  })
})

describe('caption', () => {
  const la = { kind: 'click', label: 'Entrar', at: 1 }
  test('unlocked is the person\'s turn, whatever the model did last', () => {
    expect(browserCaption('unlocked', la, 'pt')).toEqual({ kind: 'yours' })
  })
  test('locked: the prototype\'s "Clicando em Entrar"', () => {
    expect(browserCaption('locked', la, 'pt')).toEqual({ kind: 'acting', verb: 'Clicando em', target: 'Entrar' })
    expect(browserCaption('locked', la, 'en')).toEqual({ kind: 'acting', verb: 'Clicking', target: 'Entrar' })
  })
  test('nothing done yet: watching', () => {
    expect(browserCaption('locked', null, 'pt')).toEqual({ kind: 'watching' })
  })
})

describe('ringAt', () => {
  test('percent of the frame', () => {
    expect(ringAt({ kind: 'click', label: '', x: 640, y: 200, at: 0 }, { w: 1280, h: 800 })).toEqual({ left: 50, top: 25 })
  })
  test('no point, no frame or outside: no ring', () => {
    expect(ringAt({ kind: 'navigate', label: '', at: 0 }, { w: 1, h: 1 })).toBeNull()
    expect(ringAt({ kind: 'click', label: '', x: 1, y: 1, at: 0 }, null)).toBeNull()
    expect(ringAt({ kind: 'click', label: '', x: 2000, y: 1, at: 0 }, { w: 1280, h: 800 })).toBeNull()
  })
})

test('containBox: the whole frame, centred, never cropped', () => {
  expect(containBox({ width: 776, height: 253 }, { w: 1280, h: 800 })).toEqual({ left: 185, top: 0, width: 405, height: 253 })
  expect(containBox({ width: 390, height: 600 }, { w: 1280, h: 800 })).toEqual({ left: 0, top: 178, width: 390, height: 244 })
  expect(containBox({ width: 0, height: 10 }, { w: 1, h: 1 })).toBeNull()
  expect(containBox({ width: 10, height: 10 }, null)).toBeNull()
})

test('displayUrl drops the scheme and a trailing slash', () => {
  expect(displayUrl('https://loja.exemplo/entrar/')).toBe('loja.exemplo/entrar')
  expect(displayUrl('http://localhost:5173')).toBe('localhost:5173')
})

describe('setBrowserLock', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const calls: Array<{ body: unknown; grant: string | null }> = []
  const serve = (answers: Array<[number, Record<string, unknown>]>) => {
    calls.length = 0
    let i = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers)
      calls.push({ body: JSON.parse(String(init.body)), grant: h.get('X-Agentop-Owner-Grant') })
      const [status, body] = answers[Math.min(i++, answers.length - 1)]!
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }

  test('lock: one plain request, no vault', async () => {
    serve([[200, { ok: true, lock: 'locked' }]])
    let asked = 0
    const r = await setBrowserLock('m1', 'locked', true, async () => { asked++; return { ok: true, grant: 'g' } })
    expect(r).toEqual({ ok: true, lock: 'locked' })
    expect(asked).toBe(0)
    expect(calls).toEqual([{ body: { owner: 'm1', lock: 'locked' }, grant: null }])
  })

  test('unlock: proof required ⇒ the vault grant for THIS browser, then the same request with it', async () => {
    serve([[403, { ok: false, error: 'owner_proof_required' }], [200, { ok: true, lock: 'unlocked' }]])
    const asked: string[] = []
    const r = await setBrowserLock('m1', 'unlocked', true, async (id) => { asked.push(id); return { ok: true, grant: 'G1' } })
    expect(r).toEqual({ ok: true, lock: 'unlocked' })
    expect(asked).toEqual(['m1'])
    expect(calls.map(c => c.grant)).toEqual([null, 'G1'])
    expect(calls[1]!.body).toEqual({ owner: 'm1', lock: 'unlocked' })
  })

  test('no way to prove (vault without password): the pt sentence and the open-vault action', async () => {
    serve([[403, { ok: false, error: 'owner_proof_unavailable', action: { kind: 'open-vault', path: '/vault' }, sentence: 'x' }]])
    const r = await setBrowserLock('m1', 'unlocked', true, async () => ({ ok: true, grant: 'never' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.openVault).toBe(true)
    expect(r.sentence).toContain('Abra o Cofre')
    expect(calls.length).toBe(1)
  })

  test('the vault itself says unavailable (hyphen spelling): same sentence, en', async () => {
    serve([[403, { ok: false, error: 'owner_proof_required' }]])
    const r = await setBrowserLock('m1', 'unlocked', false, async () => ({ ok: false, code: 'owner-proof-unavailable', sentence: '' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.openVault).toBe(true)
    expect(r.sentence).toContain('Open the Vault')
  })

  test('a refused grant is never treated as an unlock', async () => {
    serve([[403, { ok: false, error: 'owner_proof_required' }]])
    const r = await setBrowserLock('m1', 'unlocked', true, async () => ({ ok: false, code: 'presence-cancelled', sentence: '' }))
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(1)
  })
})

test('lockRefusalSentence: our words for proof codes, else the server sentence', () => {
  expect(lockRefusalSentence('no_browser', undefined, true)).toContain('não tem um navegador')
  expect(lockRefusalSentence('weird', 'Server said so.', false)).toBe('Server said so.')
  expect(lockRefusalSentence('weird', undefined, false)).toBe('Could not change the padlock.')
})
