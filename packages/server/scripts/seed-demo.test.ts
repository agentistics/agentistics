import { describe, expect, test } from 'bun:test'
import { homedir, userInfo } from 'node:os'
import type { HarnessId, SessionMeta } from '@agentistics/core'
import { buildDemoStore } from './seed-demo'

const REAL_HOME = '/home/realuser'

function session(harness: HarnessId, i: number): SessionMeta {
  return {
    session_id: `${harness}-${i}`,
    project_path: `${REAL_HOME}/work/secret-${i}`,
    current_cwd: `${REAL_HOME}/work/secret-${i}/wt`,
    start_time: '2026-10-01T10:00:00Z',
    user_message_count: 2,
    first_prompt: `look at ${REAL_HOME}/notes`,
    title: `title ${REAL_HOME}`,
    git_remote: `github.com/realuser/secret-${i}`,
    native_session_id: `-home-realuser-work/session-${i}`,
    agent_file_reads: { [`${REAL_HOME}/work/a.ts`]: 2 },
    languages: ['TypeScript'],
    harness,
    input_tokens: 100,
    output_tokens: 50,
  } as unknown as SessionMeta
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => strings(x, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out) }
  }
  return out
}

describe('seed-demo store', () => {
  test('no field of any harness carries the real home or user name', () => {
    const harnesses: HarnessId[] = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode' as HarnessId]
    const real = new Map(harnesses.map(h => [h, [session(h, 1), session(h, 2)]] as const))
    const store = buildDemoStore(real)
    const forbidden = [REAL_HOME, 'realuser', homedir(), userInfo().username].filter(x => x.length > 2)
    for (const [harness, sessions] of store) {
      for (const s of sessions) {
        for (const str of strings(s)) {
          for (const f of forbidden) expect({ harness, str }).not.toEqual({ harness, str: expect.stringContaining(f) })
        }
      }
    }
  })

  test('real antigravity and kimi sessions are scrubbed, not passed through', () => {
    const store = buildDemoStore(new Map<HarnessId, SessionMeta[]>([
      ['claude', [session('claude', 1)]],
      ['kimi', [session('kimi', 1)]],
      ['antigravity', [session('antigravity', 1)]],
    ]))
    for (const h of ['kimi', 'antigravity'] as const) {
      expect(store.get(h)![0]!.project_path.startsWith('/home/dev/code/')).toBe(true)
    }
  })

  test('missing harnesses are synthesized with fictional paths', () => {
    const store = buildDemoStore(new Map<HarnessId, SessionMeta[]>([['claude', [session('claude', 1)]]]))
    expect(store.get('kimi')!.length).toBeGreaterThan(0)
    expect(store.get('antigravity')!.every(s => s.project_path.startsWith('/home/dev/code/'))).toBe(true)
  })
})
