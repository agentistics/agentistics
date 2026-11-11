/**
 * exposure.test.ts — unit tests for the pure profile/capability resolution.
 * No filesystem, no env mutation: every case is a plain input object.
 */
import { describe, expect, it, test } from 'bun:test'
import { resolveProfile, capabilitiesFor, type ExposureEnv } from './exposure'

const base: ExposureEnv = { exposure: undefined, allowLocalShell: false, tls: false }

describe('resolveProfile', () => {
  it('defaults to local for a solo machine', () => {
    expect(resolveProfile(base)).toBe('local')
  })

  it('honours an explicit AGENTISTICS_EXPOSURE=public', () => {
    expect(resolveProfile({ ...base, exposure: 'public' })).toBe('public')
  })

  it('rejects an unknown value by failing closed to public', () => {
    expect(resolveProfile({ ...base, exposure: 'banana' })).toBe('public')
  })

  it('treats an empty string as unset', () => {
    expect(resolveProfile({ ...base, exposure: '' })).toBe('local')
  })
})

describe('capabilitiesFor', () => {
  it('grants every local capability on a local profile', () => {
    const caps = capabilitiesFor('local', base)
    expect(caps.localShell).toBe(true)
    expect(caps.localChat).toBe(true)
    expect(caps.localTranscripts).toBe(true)
    expect(caps.mcpAdmin).toBe(true)
  })

  it('revokes local shell, chat, transcripts and mcp admin on public', () => {
    const caps = capabilitiesFor('public', { ...base, exposure: 'public' })
    expect(caps.localShell).toBe(false)
    expect(caps.localChat).toBe(false)
    expect(caps.localTranscripts).toBe(false)
    expect(caps.mcpAdmin).toBe(false)
  })

  it('never re-enables local shell on public even with the opt-in flag', () => {
    const caps = capabilitiesFor('public', {
      ...base,
      exposure: 'public',
      allowLocalShell: true,
    })
    expect(caps.localShell).toBe(false)
    expect(caps.localChat).toBe(false)
  })

  it('re-enables local shell on lan only with the explicit opt-in', () => {
    expect(capabilitiesFor('lan', { ...base }).localShell).toBe(false)
    expect(capabilitiesFor('lan', { ...base, allowLocalShell: true }).localShell).toBe(true)
  })

  it('requires owner MFA and secure cookies on public', () => {
    const caps = capabilitiesFor('public', { ...base, exposure: 'public' })
    expect(caps.requireMfaForOwner).toBe(true)
    expect(caps.requireSecureCookies).toBe(true)
  })

  it('requires owner MFA on every profile — the account is worth the same on a LAN', () => {
    // It used to be a `public`-only rule. An owner reaches every team's data wherever the port is
    // bound, and self-service recovery now leans on the second factor existing at all.
    for (const p of ['local', 'lan', 'public'] as const) {
    expect(capabilitiesFor(p, { ...base, exposure: p }).requireMfaForOwner).toBe(true)
    }
  })

  it('ties secure cookies to TLS on lan', () => {
    expect(capabilitiesFor('lan', { ...base }).requireSecureCookies).toBe(false)
    expect(capabilitiesFor('lan', { ...base, tls: true }).requireSecureCookies).toBe(true)
  })
})

test('reading the host process list follows the other local powers, never wider', () => {
  const env = { exposure: undefined, allowLocalShell: false, tls: false }
  // A solo workstation is the case live sessions exist for.
  expect(capabilitiesFor('local', env).localProcesses).toBe(true)
  // LAN process access is opt-in like every other host power.
  expect(capabilitiesFor('lan', env).localProcesses).toBe(false)
  expect(capabilitiesFor('lan', { ...env, allowLocalShell: true }).localProcesses).toBe(true)
  // Never on a published instance — a process cwd is usually a repository name.
  expect(capabilitiesFor('public', { ...env, allowLocalShell: true }).localProcesses).toBe(false)
})
