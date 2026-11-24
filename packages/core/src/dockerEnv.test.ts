import { describe, expect, test } from 'bun:test'
import {
  ENV_IMAGES, ENV_MIN_API_VERSION, apiAtLeast, applyEnvChoice, catalogProblems, decideEnvBackend, envOfferKey, envOsOf, installHint,
  resolveEnvChoice, resolveEnvImage, type DockerFacts, type EnvDecisionInput, type EnvImage,
} from './dockerEnv'

const running: DockerFacts = { present: true, running: true, version: '29.3.0', kind: 'native', apiVersion: '1.54' }
const stopped: DockerFacts = { present: true, running: false, version: '29.3.0', kind: 'native', apiVersion: null }
const none: DockerFacts = { present: false, running: false, version: null, kind: 'none', apiVersion: null }
const input = (o: Partial<EnvDecisionInput>): EnvDecisionInput => ({ flag: true, docker: running, platform: 'available', choice: undefined, image: { ok: true }, ...o })

describe('decideEnvBackend — the table of SPEC §2.1, row by row (pure)', () => {
  test('flag off, whatever Docker and the preference are: namespace, and nothing is said', () => {
    for (const docker of [running, stopped, none]) for (const choice of [undefined, 'docker', 'namespace'] as const) {
      const d = decideEnvBackend(input({ flag: false, docker, choice }))
      expect([d.backend, d.reason, d.line, d.suggest]).toEqual(['namespace', 'flag-off', '', null])
    }
  })
  test('running + available + no choice: namespace + suggestion to use Docker', () => {
    const d = decideEnvBackend(input({}))
    expect([d.backend, d.reason, d.suggest]).toEqual(['namespace', 'suggest-docker', 'use-docker'])
  })
  test('running + choice docker: docker', () => {
    const d = decideEnvBackend(input({ choice: 'docker' }))
    expect([d.backend, d.reason, d.docker]).toEqual(['docker', 'chosen-docker', true])
  })
  test('running + choice docker but no catalogue image: namespace + the missing tool, said in words', () => {
    const d = decideEnvBackend(input({ choice: 'docker', image: { ok: false, missing: ['git'] } }))
    expect([d.backend, d.reason]).toEqual(['namespace', 'no-image'])
    expect(d.line).toContain('missing: git')
  })
  test('running + choice namespace: namespace, nothing said', () => {
    const d = decideEnvBackend(input({ choice: 'namespace' }))
    expect([d.backend, d.reason, d.line, d.suggest]).toEqual(['namespace', 'chosen-namespace', '', null])
  })
  test('running + platform unavailable, any choice: namespace + "not validated on this system yet"', () => {
    for (const choice of [undefined, 'docker', 'namespace'] as const) {
      const d = decideEnvBackend(input({ platform: 'unavailable', choice }))
      expect([d.backend, d.reason]).toEqual(['namespace', 'platform-unavailable'])
      expect(d.line).toContain('not validated')
    }
  })
  test('present but stopped, no choice: namespace + a single warning line', () => {
    const d = decideEnvBackend(input({ docker: stopped }))
    expect([d.backend, d.reason]).toEqual(['namespace', 'docker-stopped-offered'])
    expect(d.line).toContain('not running')
  })
  test('present but stopped, choice docker: namespace for THIS run, with the reason and the action', () => {
    const d = decideEnvBackend(input({ docker: stopped, choice: 'docker' }))
    expect([d.backend, d.reason]).toEqual(['namespace', 'docker-stopped-chosen'])
    expect(d.line).toContain('Start Docker')
  })
  test('absent, no choice: namespace + suggestion to install', () => {
    const d = decideEnvBackend(input({ docker: none }))
    expect([d.backend, d.reason, d.suggest]).toEqual(['namespace', 'docker-missing-suggest-install', 'install-docker'])
  })
  test('absent, choice docker: namespace + "Docker is no longer installed"', () => {
    const d = decideEnvBackend(input({ docker: none, choice: 'docker' }))
    expect([d.backend, d.reason]).toEqual(['namespace', 'docker-gone'])
    expect(d.line).toContain('no longer installed')
  })
  test('running + choice docker + API below 1.45: namespace + the version', () => {
    for (const apiVersion of ['1.44', '1.40', '1.9', null, 'garbage']) {
      const d = decideEnvBackend(input({ docker: { ...running, apiVersion }, choice: 'docker' }))
      expect([d.backend, d.reason]).toEqual(['namespace', 'api-too-old'])
    }
    expect(decideEnvBackend(input({ docker: { ...running, apiVersion: '1.44' }, choice: 'docker' })).line).toContain('1.44')
    for (const apiVersion of ['1.45', '1.54', '2.0']) expect(decideEnvBackend(input({ docker: { ...running, apiVersion }, choice: 'docker' })).backend).toBe('docker')
  })
  test('never `docker` without a running, validated, new-enough Engine and a catalogue image', () => {
    for (const docker of [running, stopped, none]) for (const platform of ['available', 'unavailable'] as const) for (const flag of [true, false])
      for (const choice of [undefined, 'docker', 'namespace'] as const) for (const image of [{ ok: true as const }, { ok: false as const, missing: ['git'] }]) {
        const d = decideEnvBackend({ flag, docker, platform, choice, image })
        if (d.backend === 'docker') expect(flag && docker.running && platform === 'available' && choice === 'docker' && image.ok).toBe(true)
      }
  })
})

describe('apiAtLeast', () => {
  test('numeric, component by component', () => {
    expect(ENV_MIN_API_VERSION).toBe('1.45')
    expect(apiAtLeast('1.54')).toBe(true)
    expect(apiAtLeast('1.45')).toBe(true)
    expect(apiAtLeast('1.9')).toBe(false) // not a string compare
    expect(apiAtLeast('1.100')).toBe(true)
    expect(apiAtLeast('2')).toBe(true)
    expect(apiAtLeast(null)).toBe(false)
    expect(apiAtLeast('')).toBe(false)
  })
})

describe('envOfferKey — a refusal holds until the state changes', () => {
  test('changes when Docker appears, starts, updates, or the platform verdict moves', () => {
    const keys = new Set([envOfferKey(none, 'available'), envOfferKey(stopped, 'available'), envOfferKey(running, 'available'), envOfferKey({ ...running, apiVersion: '1.55' }, 'available'), envOfferKey(running, 'unavailable')])
    expect(keys.size).toBe(5)
    expect(envOfferKey(running, 'available')).toBe(envOfferKey({ ...running }, 'available'))
  })
})

describe('preference scope — session > project > all (most specific wins)', () => {
  const prefs = { all: 'namespace', projects: { '/repo/a': 'docker' }, sessions: { s1: 'namespace' } } as const
  test('each scope applies to what it names, and only that', () => {
    expect(resolveEnvChoice(prefs, { sessionId: 's1', projectKey: '/repo/a' })).toEqual({ choice: 'namespace', source: 'session' })
    expect(resolveEnvChoice(prefs, { sessionId: 's2', projectKey: '/repo/a' })).toEqual({ choice: 'docker', source: 'project' })
    expect(resolveEnvChoice(prefs, { sessionId: 's2', projectKey: '/repo/b' })).toEqual({ choice: 'namespace', source: 'all' })
    expect(resolveEnvChoice(undefined, { sessionId: 's1' })).toEqual({ choice: undefined, source: 'none' })
    expect(resolveEnvChoice({ projects: { '/repo/a': 'docker' } }, { sessionId: 's1' })).toEqual({ choice: undefined, source: 'none' })
  })
  test('a session choice beats a project choice beats all, in both directions', () => {
    expect(resolveEnvChoice({ all: 'docker', projects: { p: 'namespace' }, sessions: { s: 'docker' } }, { sessionId: 's', projectKey: 'p' }).choice).toBe('docker')
    expect(resolveEnvChoice({ all: 'docker', projects: { p: 'namespace' } }, { sessionId: 's', projectKey: 'p' }).choice).toBe('namespace')
    expect(resolveEnvChoice({ all: 'docker' }, { sessionId: 's', projectKey: 'p' }).choice).toBe('docker')
  })
  test('applyEnvChoice writes exactly the named scope, never mutates its input, and refuses what it cannot place', () => {
    const base = { all: 'docker' as const }
    const frozen = JSON.stringify(base)
    expect(applyEnvChoice(base, { scope: 'all', backend: 'namespace' })).toEqual({ ok: true, prefs: { all: 'namespace' } })
    expect(applyEnvChoice(base, { scope: 'session', backend: 'namespace', target: 's9' })).toEqual({ ok: true, prefs: { all: 'docker', sessions: { s9: 'namespace' } } })
    expect(applyEnvChoice(base, { scope: 'project', backend: 'docker', target: '/r' })).toEqual({ ok: true, prefs: { all: 'docker', projects: { '/r': 'docker' } } })
    expect(applyEnvChoice(base, { backend: 'docker' })).toEqual({ ok: true, prefs: { all: 'docker' } }) // default scope = all
    expect(JSON.stringify(base)).toBe(frozen)
    expect(applyEnvChoice(base, { scope: 'session', backend: 'docker' })).toEqual({ ok: false, error: 'target_required' })
    expect(applyEnvChoice(base, { scope: 'project', backend: 'docker', target: '  ' })).toEqual({ ok: false, error: 'target_required' })
    expect(applyEnvChoice(base, { scope: 'galaxy', backend: 'docker' })).toEqual({ ok: false, error: 'bad_scope' })
    expect(applyEnvChoice(base, { scope: 'all', backend: 'podman' })).toEqual({ ok: false, error: 'bad_backend' })
  })
})

describe('install hint per operating system (SPEC §2.4)', () => {
  test('envOsOf', () => {
    expect([envOsOf('linux', false), envOsOf('linux', true), envOsOf('darwin', false), envOsOf('win32', false)]).toEqual(['linux', 'wsl2', 'macos', 'windows'])
  })
  test('Linux and WSL2: Engine, validated; WSL says Engine inside WSL and warns about /mnt/c', () => {
    const l = installHint('linux')
    expect(l.validated).toBe(true)
    expect(l.cost).toContain('0.5 GB')
    expect(l.cost).toContain('administrator')
    expect(l.officialUrl).toBe('https://docs.docker.com/engine/install/')
    const w = installHint('wsl2')
    expect(w.validated).toBe(true)
    expect(w.what).toContain('inside WSL')
    expect(w.cost).toContain('/mnt/c')
  })
  test('macOS and Windows: Docker Desktop, cost marked as an estimate, NOT validated, the off-until-validated note', () => {
    for (const os of ['macos', 'windows'] as const) {
      const h = installHint(os)
      expect(h.what).toContain('Docker Desktop')
      expect(h.cost).toContain('Estimate')
      expect(h.cost).toContain('2–4 GB')
      expect(h.validated).toBe(false)
      expect(h.note).toContain('stays off until it is validated')
      expect(h.officialUrl.startsWith('https://docs.docker.com/')).toBe(true)
    }
  })
  test('every hint has numbered-able steps and never asks to run a privileged command for the user', () => {
    for (const os of ['linux', 'wsl2', 'macos', 'windows'] as const) {
      const h = installHint(os)
      expect(h.steps.length).toBeGreaterThan(2)
      expect(JSON.stringify(h)).not.toMatch(/curl[^"]*\|\s*(ba)?sh|sudo (apt|dnf|sh)/)
    }
  })
})

describe('the image catalogue (SPEC §3.4)', () => {
  test('the shipped catalogue lints clean: every entry has a digest, a date and a source', () => {
    expect(catalogProblems()).toEqual([])
    expect(ENV_IMAGES.map(i => i.key)).toContain('bun-1.3')
    for (const i of ENV_IMAGES) { expect(i.ref).toMatch(/@sha256:[0-9a-f]{64}$/); expect(i.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(i.source.length).toBeGreaterThan(8) }
  })
  test('an entry without a source, a date or a digest does not pass the lint (the MODEL_PRICING rule)', () => {
    const ok = ENV_IMAGES[0]!
    const bad = (patch: Partial<EnvImage>) => catalogProblems([{ ...ok, ...patch }])
    expect(bad({ source: '' }).join()).toContain('source is required')
    expect(bad({ verifiedAt: '' }).join()).toContain('verifiedAt')
    expect(bad({ verifiedAt: 'yesterday' }).join()).toContain('verifiedAt')
    expect(bad({ ref: 'oven/bun:1.3.14' }).join()).toContain('digest')
    expect(bad({ ref: 'oven/bun@sha256:abc' }).join()).toContain('digest')
    expect(bad({ tools: ['bun'] }).join()).toContain('sh and timeout')
    expect(catalogProblems([ok, ok]).join()).toContain('duplicate')
  })
  test('a profile chooses a KEY; a digest, a FROM or an unknown key is refused, never adopted', () => {
    expect(resolveEnvImage({ choose: 'bun-1.3' })).toMatchObject({ ok: true, image: { key: 'bun-1.3' } })
    expect(resolveEnvImage({ choose: 'oven/bun@sha256:' + 'a'.repeat(64) })).toEqual({ ok: false, missing: expect.any(Array) })
    expect(resolveEnvImage({ choose: 'ubuntu:latest' }).ok).toBe(false)
  })
  test('a needed tool the image lacks is named (no git in the shipped images)', () => {
    expect(resolveEnvImage({ choose: 'bun-1.3', needs: ['git'] })).toEqual({ ok: false, missing: ['git'] })
    expect(resolveEnvImage({ manager: 'bun', needs: ['git'] })).toEqual({ ok: false, missing: ['git'] })
    expect(resolveEnvImage({ manager: 'bun', needs: ['bun'] })).toMatchObject({ ok: true, image: { key: 'bun-1.3' } })
    expect(resolveEnvImage({ manager: 'pip' }).ok).toBe(false)
  })
})
