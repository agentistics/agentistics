/**
 * The conformance kit, run against THIS engine — and against broken ones, so a kit that judged
 * nothing could not pass here (a lint with no failing case is a lint nobody has seen work).
 *
 * The guard table is the PUBLIC host's own (`capability-guard.ts`), not a copy: an engine route
 * that declares a capability the host does not hold for its prefix must fail here exactly as it
 * would be refused at load.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_API_VERSION, apiCompatible, type CreateEngine } from '@agentistics/engine-api'
import { HARNESS_ORDER, type AgentisticsEvent } from '@agentistics/core'
import { routeCapability } from '@agentistics/server/server/capability-guard'
import { readJsonLimited } from '@agentistics/server/server/limits'
import { safeError } from '@agentistics/server/server/errors'
import { BUILT_AGAINST_API, createEngine } from '../index'
import { installHost, testHost } from '../host'
import { installedReaders, readersSource } from '../reuse'
import { runEngineConformance } from './kit'

function freshHost() {
  return testHost(mkdtempSync(join(tmpdir(), 'engine-conformance-')), { readJsonLimited, safeError })
}

async function judge(create: CreateEngine<AgentisticsEvent>) {
  const r = await runEngineConformance(create, { host: freshHost(), capabilityFor: routeCapability, totalOver: HARNESS_ORDER })
  // The preload's host is restored after every run: createEngine installs the one it is given.
  installHost(freshHost())
  return r
}

/** This engine, with one thing broken after it is created. */
function broken(mutate: (e: Awaited<ReturnType<typeof createEngine>>) => void): CreateEngine<AgentisticsEvent> {
  return async h => {
    const e = await createEngine(h)
    mutate(e)
    return e
  }
}

describe('this engine conforms', () => {
  test('the kit finds nothing', async () => {
    const r = await judge(createEngine)
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
  })

  test('the contract it was written against is one the linked host serves', () => {
    expect(apiCompatible(ENGINE_API_VERSION, BUILT_AGAINST_API)).toBe(true)
  })

  test('every harness replays, and the manifest says so without restating the list', async () => {
    const r = await judge(createEngine)
    expect([...r.manifest!.provides.replay]).toEqual([...HARNESS_ORDER])
  })

  test('with contract 1.2 the host offers the whole reuse surface, and the engine runs on it', async () => {
    const h = freshHost()
    await createEngine(h)
    expect(readersSource()).toBe('host')
    expect(installedReaders()).toBe(h.readers)
    installHost(freshHost())
  })

  test('an incomplete reuse surface is refused whole, naming what is missing', async () => {
    const h = freshHost()
    const { planTranscriptRead: _, ...partial } = h.readers
    await expect(createEngine({ ...h, readers: partial as typeof h.readers })).rejects.toThrow(/missing: planTranscriptRead/)
    expect(installedReaders()).toBe(h.readers)
    installHost(freshHost())
  })
})

describe('the kit is not vacuous — each broken engine fails by name', () => {
  const cases: [string, (e: Awaited<ReturnType<typeof createEngine>>) => void][] = [
    ['manifest.name', e => { (e.manifest as { name: string }).name = 'something-else' }],
    ['api-compatible', e => { e.manifest.apiVersion = '9.0.0' }],
    ['host-refuses:route-not-reserved', e => { e.routes.push({ prefix: '/api/data', capability: 'localShell', handle: async () => null }) }],
    ['host-refuses:route-capability', e => { e.routes[0] = { ...e.routes[0]!, capability: 'localChat' } }],
    ['host-refuses:duplicate-command', e => { e.commands.push(e.commands[0]!) }],
    ['route.unknown-path', e => { e.routes[0] = { ...e.routes[0]!, handle: async () => new Response('mine', { status: 200 }) } }],
    ['route.throws', e => { e.routes[0] = { ...e.routes[0]!, handle: async () => { throw new Error('boom') } } }],
    ['command.summary', e => { e.commands[0] = { ...e.commands[0]!, summary: { en: 'x', pt: '' } } }],
    ['integrations.total', e => { delete e.integrations.kimi }],
    ['integration.replay-xor-absent', e => { e.integrations.codex = { ...e.integrations.codex!, replayAbsent: 'both at once' } as never }],
    ['manifest.replay', e => { e.manifest.provides.replay = ['claude'] }],
    ['replay.discover', e => { e.integrations.gemini = { ...e.integrations.gemini!, replay: { discover: async () => { throw new Error('unreadable') }, replay: async () => ({ events: [], cursor: null }) } } as never }],
    ['codeHost', e => { e.manifest.provides.nativeRuntime = true }],
    ['dispose', e => { e.dispose = async () => { throw new Error('stuck') } }],
  ]
  for (const [check, mutate] of cases) {
    test(check, async () => {
      const r = await judge(broken(mutate))
      expect(r.ok).toBe(false)
      expect(r.findings.map(f => f.check)).toContain(check)
    })
  }

  test('an engine that throws at creation is one finding, not a crash of the kit', async () => {
    const r = await judge(async () => { throw new Error('no') })
    expect(r.findings.map(f => f.check)).toEqual(['create'])
  })
})
