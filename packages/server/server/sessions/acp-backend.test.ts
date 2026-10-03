/**
 * acp-backend.test.ts — A5.4's composite backend: a spawn goes over ACP only when the person opted
 * the harness in AND the engine drives it; everything else — and a failed ACP start — is tmux's, and
 * every verb of a tmux session is untouched.
 */
import { describe, expect, test } from 'bun:test'
import type { EngineAcp, EngineAcpSession } from '@agentistics/engine-api'
import { harnessOfArgv, withAcp } from './acp-backend'
import type { BackendSpawn, SessionBackend } from './types'

function fakeBase(): SessionBackend & { calls: string[] } {
  const calls: string[] = []
  const rec = <T>(name: string, v: T) => async (..._a: unknown[]) => { calls.push(name); return v }
  return {
    calls, id: 'tmux',
    unavailable: rec('unavailable', undefined),
    spawn: rec('spawn', undefined),
    list: rec('list', [{ id: 't-1', createdMs: 1, attached: false, alive: true, lastActivityMs: 1 }]),
    capture: rec('capture', ['tmux frame']),
    captureTerminal: rec('captureTerminal', null),
    sendText: rec('sendText', true), sendTextRaw: rec('sendTextRaw', true), sendKey: rec('sendKey', true), sendPaste: rec('sendPaste', true),
    kill: rec('kill', true), attachCommand: () => ['tmux', 'attach'], detachHint: rec('detachHint', 'C-b d'),
  } as unknown as SessionBackend & { calls: string[] }
}

function fakeAcp(ok = true): EngineAcp & { started: unknown[]; session: EngineAcpSession & { prompts: string[]; answers: number[]; disposed: boolean } } {
  const session = {
    id: 'm-1', acpSessionId: 'acp-1', prompts: [] as string[], answers: [] as number[], disposed: false,
    state: 'waiting-approval' as ReturnType<EngineAcpSession['activity']>,
    activity() { return this.state }, dialog: () => ({ options: ['Allow once', 'Reject'] }),
    screen: (n: number) => ['> hi', 'Permission needed: x', '  1. Allow once', '  2. Reject'].slice(-n),
    lastActivityMs: () => 42, prompt(t: string) { this.prompts.push(t); return true }, answer(c: number) { this.answers.push(c); return c <= 2 },
    cancel() {}, dispose() { this.disposed = true; this.state = 'exited' },
  }
  const started: unknown[] = []
  return {
    started, session: session as never,
    harnesses: () => ['gemini', 'kimi'],
    start: async req => { started.push(req); return ok ? { ok: true, session: session as never } : { ok: false, reason: 'login needed' } },
  }
}

const req = (bin: string, id = 'm-1'): BackendSpawn => ({ id, cwd: '/w', argv: [`/usr/bin/${bin}`, '--model', 'x'], initialPrompt: { text: 'hi' } as never })

describe('harnessOfArgv', () => {
  test('by the binary\'s base name against the spawn specs', () => {
    expect(harnessOfArgv(['/usr/local/bin/gemini', '-m', 'x'])).toBe('gemini')
    expect(harnessOfArgv(['claude'])).toBe('claude')
    expect(harnessOfArgv(['something-else'])).toBeNull()
  })
})

describe('withAcp', () => {
  test('opted in + driven by the engine: started over ACP, and every verb of that session is the ACP session\'s', async () => {
    const base = fakeBase()
    const acp = fakeAcp()
    const b = withAcp(base, { acp: async () => acp, allowed: async () => ['gemini'] })
    await b.spawn(req('gemini'))
    expect(acp.started).toEqual([{ id: 'm-1', harness: 'gemini', cwd: '/w', initialPrompt: 'hi' }])
    expect(base.calls).not.toContain('spawn')
    expect((await b.list()).map(s => [s.id, s.alive])).toEqual([['t-1', true], ['m-1', true]])
    expect(await b.capture('m-1', 2)).toEqual(['  1. Allow once', '  2. Reject'])
    expect(b.activityOf!('m-1')).toBe('waiting-approval')
    expect(b.dialogOf!('m-1')).toEqual(['Allow once', 'Reject'])
    expect(await b.sendKey('m-1', '2')).toBe(true)
    expect(acp.session.answers).toEqual([2])
    expect(await b.sendText('m-1', 'next')).toBe(true)
    expect(acp.session.prompts).toEqual(['next'])
    expect(b.attachCommand('m-1').join(' ')).toContain('no terminal')
    expect(await b.kill('m-1')).toBe(true)
    expect(acp.session.disposed).toBe(true)
    expect(base.calls.filter(c => c !== 'list')).toEqual([])
  })

  test('not opted in, not driven, or a failed ACP start: tmux, the same request', async () => {
    for (const [allowed, bin, ok] of [[[], 'gemini', true], [['claude'], 'claude', true], [['gemini'], 'gemini', false]] as const) {
      const base = fakeBase()
      const b = withAcp(base, { acp: async () => fakeAcp(ok), allowed: async () => allowed })
      await b.spawn(req(bin))
      expect(base.calls).toContain('spawn')
      expect(b.activityOf!('m-1')).toBeUndefined()
    }
    const base = fakeBase()
    const b = withAcp(base, { acp: async () => null, allowed: async () => ['gemini'] })
    await b.spawn(req('gemini'))
    expect(base.calls).toContain('spawn')
  })

  test('a tmux session\'s verbs are the base\'s, untouched', async () => {
    const base = fakeBase()
    const b = withAcp(base, { acp: async () => fakeAcp(), allowed: async () => [] })
    expect(await b.capture('t-1', 10)).toEqual(['tmux frame'])
    await b.sendText('t-1', 'x'); await b.sendKey('t-1', '1'); await b.kill('t-1')
    expect(base.calls).toEqual(['capture', 'sendText', 'sendKey', 'kill'])
    expect(b.attachCommand('t-1')).toEqual(['tmux', 'attach'])
  })
})
