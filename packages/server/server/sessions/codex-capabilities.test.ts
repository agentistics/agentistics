import { describe, expect, it } from 'bun:test'
import { createCodexCapabilityProbe } from './codex-capabilities'
import { planSpawn } from './spawn-spec'

describe('Codex --no-daemon capability', () => {
  it.each([
    ['0.161.0', 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run without the shared background server', true],
    ['0.155.1', 'Usage: codex [OPTIONS] [PROMPT]\n      --help  Print help', false],
    ['unrelated flag', '      --no-daemon-other  Something else', false],
  ] as const)('checks help for %s', async (_version, help, supported) => {
    const probe = createCodexCapabilityProbe({ binary: () => '/bin/codex', mtime: async () => 1, help: async () => help })
    expect(await probe()).toBe(supported)
    for (const resumeId of [undefined, 'thread-1']) {
      const planned = planSpawn({ harness: 'codex', cwd: '/tmp', resumeId }, { codexNoDaemon: await probe() })
      expect(planned.ok).toBe(true)
      if (planned.ok) expect(planned.plan.argv).toEqual(['codex', ...(supported ? ['--no-daemon'] : []), ...(resumeId ? ['resume', resumeId] : [])])
    }
  })

  it.each(['nonzero exit', 'timeout'])('omits the flag and retries (never caches) a help probe failure: %s', async reason => {
    let calls = 0
    const probe = createCodexCapabilityProbe({
      binary: () => '/bin/codex', mtime: async () => 1,
      help: async () => { calls++; throw new Error(reason) },
    })
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(false)
    expect(calls).toBe(2)
    for (const resumeId of [undefined, 'thread-1']) {
      const planned = planSpawn({ harness: 'codex', cwd: '/tmp', resumeId }, { codexNoDaemon: await probe() })
      expect(planned.ok).toBe(true)
      if (planned.ok) expect(planned.plan.argv).not.toContain('--no-daemon')
    }
  })

  it('recovers once a failed probe later reads help with the flag', async () => {
    let calls = 0
    const probe = createCodexCapabilityProbe({
      binary: () => '/bin/codex', mtime: async () => 1,
      help: async () => { calls++; if (calls === 1) throw new Error('timeout'); return '--no-daemon' },
    })
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)
    expect(calls).toBe(2)
  })

  it('shares concurrent probes and invalidates on path or mtime changes', async () => {
    let path = '/old/codex', mtime = 1, calls = 0
    const probe = createCodexCapabilityProbe({
      binary: () => path, mtime: async () => mtime,
      help: async () => { calls++; return calls === 1 ? '--help' : '--no-daemon' },
    })
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([false, false, false])
    expect(calls).toBe(1)
    mtime = 2
    expect(await probe()).toBe(true)
    expect(calls).toBe(2)
    path = '/new/codex'
    expect(await probe()).toBe(true)
    expect(await probe()).toBe(true)
    expect(calls).toBe(3)
  })

  it('omits the flag when the binary is missing or cannot be statted', async () => {
    let path: string | null = null, calls = 0
    const probe = createCodexCapabilityProbe({
      binary: () => path,
      mtime: async () => { throw new Error('stat failed') },
      help: async () => { calls++; return '--no-daemon' },
    })
    expect(await probe()).toBe(false)
    path = '/bin/codex'
    expect(await probe()).toBe(false)
    expect(calls).toBe(0)
  })
})
