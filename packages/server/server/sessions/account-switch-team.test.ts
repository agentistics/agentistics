import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A separate process binds config/registry to a throwaway HOME. Keep the REAL switch link,
// registry writes and message dispatch; replace only harness processes/accounts/transcripts.
async function scenario(source: string, target: string, opts: { worker?: boolean; fails?: boolean; unlinked?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-switch-team-'))
  const script = `
    const { addSession, readRegistry, patchSession } = await import(${JSON.stringify(join(import.meta.dir, 'registry.ts'))})
    const { switchSessionAccountImpl } = await import(${JSON.stringify(join(import.meta.dir, 'account-switch-host.ts'))})
    const { sendSessionMessage, defaultMessageDeps } = await import(${JSON.stringify(join(import.meta.dir, 'session-message.ts'))})
    const { parentLinkOf } = await import(${JSON.stringify(join(import.meta.dir, 'spawn-context.ts'))})
    const source = ${JSON.stringify(source)}, target = ${JSON.stringify(target)}, opts = ${JSON.stringify(opts)}
    const row = (id, extra = {}) => ({ id, harness: source, cwd: '/w', createdAt: '2026-11-05T22:00:00Z', ...extra })
    await addSession(row('old', { conversationId: 'conv-old', ...(opts.worker ? { parentSessionId: 'boss', parentConversationId: 'conv-boss' } : {}) }))
    await addSession(row('live', { parentSessionId: 'old', parentConversationId: 'conv-old' }))
    await addSession(row('ended', { parentSessionId: 'old', endedAt: '2026-11-05T22:01:00Z' }))
    await addSession(row('conversation-only', { parentSessionId: 'previous-id', parentConversationId: 'conv-old' }))
    await addSession(row('other', { parentSessionId: 'someone-else' }))
    const alive = new Set(['old', 'live'])
    const account = (id, harness) => ({ id, harness, root: null, bound: true, available: true, firstSeen: 1 })
    const switched = await switchSessionAccountImpl({ id: 'old', harness: target, accountId: 'target' }, {
      lang: 'en',
      withLock: async (_id, fn) => fn(),
      backend: { list: async () => [...alive].map(id => ({ id, alive: true })), kill: async id => { alive.delete(id); return true } },
      resume: async () => { throw new Error('cross-harness switch must spawn') },
      spawn: async req => {
        if (opts.fails) return { ok: false, message: 'launch failed' }
        await addSession({ ...row('new'), harness: target, ...(opts.unlinked ? {} : { conversationId: 'conv-new' }),
          ...(req.parentSessionId ? { parentSessionId: req.parentSessionId, parentConversationId: 'conv-boss' } : {}) })
        alive.add('new')
        return { ok: true, id: 'new', message: 'started' }
      },
      io: {
        context: async () => ({ enabled: true, accounts: [account('source', source), account('target', target)] }),
        startable: async () => [source, target], turns: async () => ({ turns: [] }),
        role: async () => opts.worker ? 'worker' : 'leader', label: async () => undefined,
        killAndRetire: async (id, kill) => { if (!await kill()) return false; return patchSession(id, { endedAt: '2026-11-05T22:02:00Z' }) },
      },
    })
    const rows = await readRegistry()
    const prompts = []
    let now = Date.now()
    const defaults = await defaultMessageDeps()
    const message = async to => sendSessionMessage('live', { to, kind: 'question', body: 'worker report' }, {
      ...defaults, rows: async () => rows.filter(r => !r.endedAt).map(r => ({ ...r, title: r.id })), now: () => now += 2500,
      senderTask: async () => ({}), prompt: async (id, text) => { prompts.push({ id, text }); return { ok: alive.has(id) } },
    })
    const parent = rows.find(r => r.id === 'live').parentSessionId
    const delivered = await message(parent)
    // A worker already running keeps the old parent's id in its briefing.
    const staleDelivered = await message('conv-old')
    const staleIdDelivered = await message('old')
    console.log(JSON.stringify({ switched, rows, delivered, staleDelivered, staleIdDelivered, prompts, newParent: await parentLinkOf('old', { followHandoff: true }) }))
  `
  try {
    const proc = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: dir, AGENTISTICS_DIR: join(dir, 'data') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new Error(stderr)
    return JSON.parse(stdout.trim().split('\n').at(-1)!)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('account switch preserves the team across harnesses (real registry/link)', () => {
  for (const [source, target] of [['claude', 'codex'], ['codex', 'claude']]) {
    test(`${source} → ${target}: live and ended children follow the successor`, async () => {
      const out = await scenario(source!, target!)
      expect(out.switched).toMatchObject({ ok: true, id: 'new' })
      for (const id of ['live', 'ended', 'conversation-only']) {
        expect(out.rows.find((r: any) => r.id === id)).toMatchObject({ parentSessionId: 'new', parentConversationId: 'conv-new' })
      }
      expect(out.rows.find((r: any) => r.id === 'new').parentSessionId).toBeUndefined()
      expect(out.rows.find((r: any) => r.id === 'other').parentSessionId).toBe('someone-else')
      expect(out.delivered).toMatchObject({ ok: true, to: 'new', delivered: true })
      expect(out.staleDelivered).toMatchObject({ ok: true, to: 'new', delivered: true })
      expect(out.staleIdDelivered).toMatchObject({ ok: true, to: 'new', delivered: true })
      expect(out.prompts.map((p: any) => p.id)).toEqual(['new', 'new', 'new'])
      expect(out.newParent).toEqual({ parentSessionId: 'new', parentConversationId: 'conv-new' })
    })
  }

  test('a worker replacement keeps its own parent while its children follow it', async () => {
    const out = await scenario('claude', 'codex', { worker: true })
    expect(out.rows.find((r: any) => r.id === 'new')).toMatchObject({ parentSessionId: 'boss', parentConversationId: 'conv-boss' })
    expect(out.rows.find((r: any) => r.id === 'live').parentSessionId).toBe('new')
  })

  test('an unlinked successor clears the old parent conversation', async () => {
    const out = await scenario('claude', 'codex', { unlinked: true })
    const child = out.rows.find((r: any) => r.id === 'live')
    expect(child.parentSessionId).toBe('new')
    expect(child.parentConversationId).toBeUndefined()
  })

  test('a failed launch leaves the previous team and message destination intact', async () => {
    const out = await scenario('claude', 'codex', { fails: true })
    expect(out.switched.ok).toBe(false)
    expect(out.rows.find((r: any) => r.id === 'old').handoffTo).toBeUndefined()
    expect(out.rows.find((r: any) => r.id === 'live').parentSessionId).toBe('old')
    expect(out.delivered).toMatchObject({ ok: true, to: 'old' })
  })
})
