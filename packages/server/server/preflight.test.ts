import { describe, expect, it } from 'bun:test'
import { runPreflight, allPassed, type PreflightInput } from './preflight'

const good: PreflightInput = {
  profile: 'public',
  caps: {
    localShell: false,
    localChat: false,
    localTranscripts: false,
    localProcesses: false,
    mcpAdmin: false,
    requireMfaForOwner: true,
    requireSecureCookies: true,
  },
  tls: true,
  trustProxy: true,
  allowedOrigins: [],
}

const idOf = (checks: ReturnType<typeof runPreflight>, id: string) => checks.find(c => c.id === id)!

describe('runPreflight', () => {
  it('passes a fully hardened public instance', () => {
    expect(allPassed(runPreflight(good))).toBe(true)
  })

  it('fails when local shell is still reachable', () => {
    const checks = runPreflight({ ...good, caps: { ...good.caps, localShell: true } })
    expect(idOf(checks, 'local-shell').status).toBe('fail')
    expect(allPassed(checks)).toBe(false)
  })

  it('fails when any other host-power capability is reachable', () => {
    expect(allPassed(runPreflight({ ...good, caps: { ...good.caps, localTranscripts: true } }))).toBe(false)
    expect(allPassed(runPreflight({ ...good, caps: { ...good.caps, mcpAdmin: true } }))).toBe(false)
  })

  it('fails when TLS is off on a public profile', () => {
    expect(idOf(runPreflight({ ...good, tls: false }), 'tls').status).toBe('fail')
  })

  it('warns rather than fails when forwarded-IP trust is off', () => {
    const checks = runPreflight({ ...good, trustProxy: false })
    expect(idOf(checks, 'trust-proxy').status).toBe('warn')
    expect(allPassed(checks)).toBe(true)
  })

  it('fails a plaintext cross-origin allowlist entry', () => {
    expect(idOf(runPreflight({ ...good, allowedOrigins: ['http://ops.example.com'] }), 'cors').status).toBe('fail')
    expect(idOf(runPreflight({ ...good, allowedOrigins: ['https://ops.example.com'] }), 'cors').status).toBe('pass')
  })

  it('does not demand TLS on a local profile', () => {
    const local = runPreflight({
      ...good,
      profile: 'local',
      tls: false,
      caps: { ...good.caps, localShell: true },
    })
    expect(allPassed(local)).toBe(true)
  })

  it('reports every check even when they pass, so the operator sees the whole surface', () => {
    const ids = runPreflight(good).map(c => c.id)
    expect(ids).toEqual(['local-shell', 'tls', 'trust-proxy', 'cors'])
  })
})

describe('the native-bind check (S-1)', () => {
  it('is absent when the caller has not wired up native-bind.ts', () => {
    const checks = runPreflight(good)
    expect(checks.find(c => c.id === 'native-bind')).toBeUndefined()
  })

  it('fails, never a reassuring pass, when the bind could not be read at all', () => {
    const checks = runPreflight({
      ...good,
      nativeBind: { ports: [47291, 47292], result: { kind: 'unreadable', reason: 'no /proc, no lsof' } },
    })
    const nb = checks.find(c => c.id === 'native-bind')!
    expect(nb.status).toBe('fail')
    expect(nb.detail).toContain('Could not read')
    expect(allPassed(checks)).toBe(false)
  })

  it('warns, never passes, when nothing is listening on the checked ports', () => {
    const checks = runPreflight({
      ...good,
      nativeBind: { ports: [47291, 47292], result: { kind: 'read', listeners: [] } },
    })
    const nb = checks.find(c => c.id === 'native-bind')!
    expect(nb.status).toBe('warn')
    expect(nb.detail).toContain('47291')
    expect(nb.detail).toContain('47292')
    expect(allPassed(checks)).toBe(true)
  })

  it('passes when every listener is loopback-only, on any profile', () => {
    const checks = runPreflight({
      ...good,
      profile: 'public',
      nativeBind: {
        ports: [47291, 47292],
        result: { kind: 'read', listeners: [{ port: 47291, address: '127.0.0.1' }, { port: 47292, address: '::1' }] },
      },
    })
    expect(checks.find(c => c.id === 'native-bind')!.status).toBe('pass')
    expect(allPassed(checks)).toBe(true)
  })

  it('warns and names S-1 when the local profile is bound wide open', () => {
    const checks = runPreflight({
      ...good,
      profile: 'local',
      nativeBind: {
        ports: [47291, 47292],
        result: { kind: 'read', listeners: [{ port: 47291, address: '0.0.0.0' }] },
      },
    })
    const nb = checks.find(c => c.id === 'native-bind')!
    expect(nb.status).toBe('warn')
    expect(nb.detail).toContain('0.0.0.0:47291')
    expect(nb.detail).toContain('S-1')
    expect(nb.detail).toContain('local')
    expect(allPassed(checks)).toBe(true)
  })

  it('passes on the lan profile, which intends a wide bind', () => {
    const checks = runPreflight({
      ...good,
      profile: 'lan',
      nativeBind: {
        ports: [47291, 47292],
        result: { kind: 'read', listeners: [{ port: 47291, address: '0.0.0.0' }] },
      },
    })
    const nb = checks.find(c => c.id === 'native-bind')!
    expect(nb.status).toBe('pass')
    expect(nb.detail).toContain('lan')
    expect(allPassed(checks)).toBe(true)
  })

  it('fails on the strict (public/--exposed) bar unless every listener is loopback', () => {
    const checks = runPreflight({
      ...good,
      profile: 'public',
      nativeBind: {
        ports: [47291, 47292],
        result: { kind: 'read', listeners: [{ port: 47291, address: '0.0.0.0' }, { port: 47292, address: '127.0.0.1' }] },
      },
    })
    const nb = checks.find(c => c.id === 'native-bind')!
    expect(nb.status).toBe('fail')
    expect(nb.detail).toContain('0.0.0.0:47291')
    expect(nb.detail).not.toContain('127.0.0.1:47292')
    expect(allPassed(checks)).toBe(false)
  })
})
